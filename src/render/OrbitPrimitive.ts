import {
  BlendingState,
  BoundingSphere,
  Cartesian3,
  type Color,
  ComponentDatatype,
  IndexDatatype,
  JulianDate,
  Matrix3,
  Matrix4,
  PrimitiveType,
  SceneMode,
  Transforms,
} from 'cesium';

import { gmstAt } from '../sgp4/propagate.js';
import { RING_VERTEX_FLOATS, type RingBuffers } from '../worker/protocol.js';
import {
  type CesiumInternals,
  type Destroyable,
  type FrameState,
  getCesiumInternals,
  type GpuBuffer,
} from './cesiumInternals.js';
import {
  ATTRIBUTE_LOCATIONS,
  FRAGMENT_SHADER_2D,
  FRAGMENT_SHADER_3D,
  VERTEX_SHADER_2D,
  VERTEX_SHADER_3D,
} from './orbitShaders.js';

/** One shard's rings, and what the primitive needs to filter and colour them. */
export interface RingBatch {
  rings: RingBuffers;
  /** Catalog index of the batch's first satellite. */
  start: number;
  /** Colour group of each satellite of the batch (its regime code). */
  groups: Uint8Array;
}

interface GpuBatch {
  /** What index rebuilds read. The vertices live on the GPU only. */
  source: Pick<RingBatch, 'start' | 'groups'> &
    Pick<RingBuffers, 'indices' | 'indexStart' | 'indexCount'>;
  vertexBuffer: GpuBuffer;
  vertexArray: Destroyable | undefined;
  /** Per colour group, where its segments sit in the current index buffer. */
  ranges: { offset: number; count: number }[];
}

const FLOAT_BYTES = Float32Array.BYTES_PER_ELEMENT;
const scratchRotation = new Matrix3();

/**
 * Every orbit of a catalog as `LINES` draw commands: rings in 3D, ground tracks
 * in 2D, from the same GPU buffers. One draw call per (shard, colour group).
 *
 * It bypasses `Primitive` and its geometry pipeline on purpose. That pipeline
 * splits positions into high and low floats, projects a second copy for 2D and
 * builds everything synchronously: four times the memory and a long stall for
 * buffers that come out of the workers ready to upload.
 *
 * **Filtering never re-uploads vertices.** Each satellite owns a range of the
 * index buffer; a new filter rebuilds only the index buffer from the ranges of
 * the visible satellites, grouped by colour so each group is one contiguous run.
 *
 * **Draw order.** Translucent lines are blended in the opaque pass, where
 * commands run in the order they are pushed, one colour group after another in
 * `drawOrder`. The translucent pass would sort them with an order-independent
 * weighting that, at planetary distances, turns into a plain average: the
 * densest group (LEO) would then wash out every other one.
 */
export class OrbitPrimitive {
  /**
   * Whether the orbits are drawn. `PrimitiveCollection` calls `update` on every
   * child whatever its `show`, so `update` checks it itself.
   */
  show = true;

  private readonly internals: CesiumInternals | null;
  private readonly colors: readonly Color[];
  private readonly drawOrder: readonly number[];
  private batches: RingBatch[] = [];
  private gpu: GpuBatch[] = [];
  private visible: Uint8Array | null = null;
  private epoch = new JulianDate();
  private theta0 = 0;
  private boundingSphere = new BoundingSphere(Cartesian3.ZERO, 0);
  private readonly modelMatrix = Matrix4.clone(Matrix4.IDENTITY);
  /** The frame being drawn, read by the 2D uniforms. */
  private readonly currentTime = new JulianDate();
  private commands3D: unknown[] | undefined;
  private commands2D: unknown[] | undefined;
  private program3D: Destroyable | undefined;
  private program2D: Destroyable | undefined;
  private buffersDirty = false;
  private indicesDirty = false;
  private failed = false;
  private destroyed = false;

  /**
   * @param colors Colour of each group, indexed by group code.
   * @param drawOrder Group codes in the order their commands are issued.
   */
  constructor(colors: readonly Color[], drawOrder: readonly number[]) {
    this.internals = getCesiumInternals();
    this.colors = colors;
    this.drawOrder = drawOrder;
  }

  /** Replaces the rings. They are uploaded on the next frame. */
  setBatches(batches: readonly RingBatch[], epochMs: number): void {
    this.batches = batches.filter((batch) => batch.rings.indices.length > 0);
    this.epoch = JulianDate.fromDate(new Date(epochMs));
    this.theta0 = gmstAt(epochMs);
    const radius = Math.max(0, ...this.batches.map((batch) => batch.rings.radius));
    this.boundingSphere = new BoundingSphere(Cartesian3.ZERO, radius);
    this.buffersDirty = true;
  }

  /** Which catalog indices to draw (non-zero), or all of them with `null`. */
  setVisibility(visible: Uint8Array | null): void {
    this.visible = visible;
    this.indicesDirty = true;
  }

  /** Called by the `PrimitiveCollection` once per frame. */
  update(frameState: FrameState): void {
    const { mode } = frameState;
    if (!this.show || this.failed || !this.internals || !frameState.passes.render) return;
    // Neither shape holds half-way through a morph.
    if (mode !== SceneMode.SCENE3D && mode !== SceneMode.SCENE2D) return;

    // An exception thrown from here would stop Cesium's render loop, globe
    // included. This code relies on internal API, so a failure is contained.
    try {
      JulianDate.clone(frameState.time, this.currentTime);
      this.prepare(frameState.context, this.internals);
      if (mode === SceneMode.SCENE3D) {
        const rotation = Transforms.computeTemeToPseudoFixedMatrix(
          frameState.time,
          scratchRotation,
        );
        Matrix4.fromRotationTranslation(rotation, Cartesian3.ZERO, this.modelMatrix);
        this.commands3D ??= this.createCommands(frameState.context, this.internals, false);
        for (const command of this.commands3D) frameState.commandList.push(command);
      } else {
        this.commands2D ??= this.createCommands(frameState.context, this.internals, true);
        for (const command of this.commands2D) frameState.commandList.push(command);
      }
    } catch (error) {
      this.failed = true;
      console.error('[cesium-sgp4-viewer] orbits disabled: could not draw them', error);
    }
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  destroy(): void {
    this.releaseBuffers();
    this.program3D?.destroy();
    this.program2D?.destroy();
    this.destroyed = true;
  }

  private prepare(context: unknown, internals: CesiumInternals): void {
    if (this.buffersDirty) {
      this.releaseBuffers();
      this.gpu = this.batches.map(({ rings, start, groups }) => {
        const vertexBuffer = internals.Buffer.createVertexBuffer({
          context,
          typedArray: rings.vertices,
          usage: internals.BufferUsage.STATIC_DRAW,
        });
        // Kept across index rebuilds: destroyed here, never by a vertex array.
        vertexBuffer.vertexArrayDestroyable = false;
        const { indices, indexStart, indexCount } = rings;
        const source = { start, groups, indices, indexStart, indexCount };
        return { source, vertexBuffer, vertexArray: undefined, ranges: [] };
      });
      // Uploaded: the vertices, most of the rings' memory, can be collected.
      this.batches = [];
      this.buffersDirty = false;
      this.indicesDirty = true;
    }

    if (this.indicesDirty) {
      for (const batch of this.gpu) this.rebuildIndices(batch, context, internals);
      this.commands3D = undefined;
      this.commands2D = undefined;
      this.indicesDirty = false;
    }
  }

  /** Gathers the visible satellites' index ranges, one colour group after another. */
  private rebuildIndices(batch: GpuBatch, context: unknown, internals: CesiumInternals): void {
    const { start, groups, indexStart, indexCount } = batch.source;
    const { visible } = this;
    const isVisible = (j: number) => visible === null || visible[start + j] !== 0;

    let total = 0;
    for (let j = 0; j < groups.length; j++) if (isVisible(j)) total += indexCount[j]!;
    const indices = new Uint32Array(Math.max(total, 2));

    batch.ranges = this.colors.map(() => ({ offset: 0, count: 0 }));
    let cursor = 0;
    for (const group of this.drawOrder) {
      const range = batch.ranges[group]!;
      range.offset = cursor;
      for (let j = 0; j < groups.length; j++) {
        if (groups[j] !== group || !isVisible(j)) continue;
        const from = indexStart[j]!;
        const count = indexCount[j]!;
        indices.set(batch.source.indices.subarray(from, from + count), cursor);
        cursor += count;
      }
      range.count = cursor - range.offset;
    }

    batch.vertexArray?.destroy();
    const strideInBytes = RING_VERTEX_FLOATS * FLOAT_BYTES;
    batch.vertexArray = new internals.VertexArray({
      context,
      attributes: [
        {
          index: ATTRIBUTE_LOCATIONS.position,
          vertexBuffer: batch.vertexBuffer,
          componentsPerAttribute: 3,
          componentDatatype: ComponentDatatype.FLOAT,
          offsetInBytes: 0,
          strideInBytes,
        },
        {
          index: ATTRIBUTE_LOCATIONS.timing,
          vertexBuffer: batch.vertexBuffer,
          componentsPerAttribute: 2,
          componentDatatype: ComponentDatatype.FLOAT,
          offsetInBytes: 3 * FLOAT_BYTES,
          strideInBytes,
        },
      ],
      indexBuffer: internals.Buffer.createIndexBuffer({
        context,
        typedArray: indices,
        usage: internals.BufferUsage.STATIC_DRAW,
        indexDatatype: IndexDatatype.UNSIGNED_INT,
      }),
    });
  }

  private createCommands(context: unknown, internals: CesiumInternals, is2D: boolean): unknown[] {
    const program = is2D
      ? (this.program2D ??= internals.ShaderProgram.fromCache({
          context,
          vertexShaderSource: VERTEX_SHADER_2D,
          fragmentShaderSource: FRAGMENT_SHADER_2D,
          attributeLocations: ATTRIBUTE_LOCATIONS,
        }))
      : (this.program3D ??= internals.ShaderProgram.fromCache({
          context,
          vertexShaderSource: VERTEX_SHADER_3D,
          fragmentShaderSource: FRAGMENT_SHADER_3D,
          attributeLocations: ATTRIBUTE_LOCATIONS,
        }));

    const commands: unknown[] = [];
    for (const group of this.drawOrder) {
      const color = this.colors[group]!;
      const isTranslucent = color.alpha < 1;
      const renderState = internals.RenderState.fromCache({
        // On a map the track lies on the imagery: a depth test could only make
        // them fight.
        depthTest: { enabled: !is2D },
        // A translucent ring writing depth would cut the rings drawn after it.
        depthMask: !is2D && !isTranslucent,
        // Typed `any` by Cesium: narrowed so it cannot leak further.
        blending: (isTranslucent ? BlendingState.ALPHA_BLEND : BlendingState.DISABLED) as unknown,
      });
      const uniformMap = is2D
        ? {
            u_color: () => color,
            u_dt: () => JulianDate.secondsDifference(this.currentTime, this.epoch),
            u_theta0: () => this.theta0,
          }
        : { u_color: () => color };

      for (const batch of this.gpu) {
        const range = batch.ranges[group];
        if (!range || range.count === 0) continue;
        commands.push(
          new internals.DrawCommand({
            owner: this,
            primitiveType: PrimitiveType.LINES,
            vertexArray: batch.vertexArray,
            offset: range.offset,
            count: range.count,
            shaderProgram: program,
            uniformMap,
            renderState,
            pass: internals.Pass.OPAQUE,
            // In 2D the vertex shader outputs map coordinates directly, over the
            // whole map: no model matrix, nothing to cull.
            modelMatrix: is2D ? Matrix4.IDENTITY : this.modelMatrix,
            boundingVolume: is2D ? undefined : this.boundingSphere,
            cull: !is2D,
          }),
        );
      }
    }
    return commands;
  }

  private releaseBuffers(): void {
    for (const batch of this.gpu) {
      batch.vertexArray?.destroy();
      batch.vertexBuffer.destroy();
    }
    this.gpu = [];
    this.commands3D = undefined;
    this.commands2D = undefined;
  }
}

import {
  BlendingState,
  BoundingSphere,
  Cartesian3,
  Cartesian4,
  type Color,
  ComponentDatatype,
  Matrix4,
  type NearFarScalar,
  PrimitiveType,
  SceneMode,
} from 'cesium';

import {
  type CesiumInternals,
  type Destroyable,
  type FrameState,
  getCesiumInternals,
  type GpuBuffer,
  type PickId,
} from './cesiumInternals.js';
import {
  POINT_ATTRIBUTE_LOCATIONS,
  POINT_FLOATS,
  POINT_FRAGMENT_SHADER,
  POINT_VERTEX_SHADER,
} from './pointShaders.js';

const FLOAT_BYTES = Float32Array.BYTES_PER_ELEMENT;
/** Bytes per point in the static buffer: colour, then pick colour, RGBA each. */
const COLOR_BYTES = 8;

export interface PointsStyle {
  /** Point diameter in pixels. */
  pixelSize: number;
  scaleByDistance?: NearFarScalar;
  translucencyByDistance?: NearFarScalar;
}

/** What `scene.pick` returns for a point. */
export interface PickedPoint {
  primitive: PointsPrimitive;
  index: number;
}

/** A near-far scalar as the shader takes it; without one, 1 at any distance. */
const toUniform = (scalar: NearFarScalar | undefined): Cartesian4 =>
  scalar
    ? new Cartesian4(scalar.near, scalar.nearValue, scalar.far, scalar.farValue)
    : new Cartesian4(0, 1, 1, 1);

/**
 * One point per satellite, drawn by a single `POINTS` command from a buffer the
 * caller rewrites whenever the clock moves.
 *
 * It replaces a `PointPrimitiveCollection`, where moving the catalog meant a
 * setter call per point per frame, then Cesium copying every changed point
 * again into its own buffer: most of the frame with tens of thousands of
 * points. Here a frame is one loop over a typed array and one upload.
 *
 * Like the orbits, the points blend in the opaque pass, in the order the
 * primitives were added, so they land over the orbits. Picking goes through
 * Cesium's pick pass, with a pick colour per point: `scene.pick` answers with a
 * {@link PickedPoint}.
 */
export class PointsPrimitive {
  /** Written by the caller with `writePoint` and `hidePoint`, uploaded after {@link markDirty}. */
  readonly vertices: Float32Array;
  /** During a morph, 1 keeps the points' heights, 0 lays them on the map. */
  morphHeight = 1;

  private readonly internals: CesiumInternals | null;
  private readonly colors: readonly Color[];
  private readonly uniformMap: Record<string, () => unknown>;
  private readonly boundingSphere = new BoundingSphere(Cartesian3.ZERO, 0);
  private readonly commands = new Map<SceneMode, unknown>();
  private vertexBuffer: GpuBuffer | undefined;
  private vertexArray: Destroyable | undefined;
  private program: Destroyable | undefined;
  private pickIds: PickId[] = [];
  private dirty = false;
  private failed = false;
  private destroyed = false;

  /** @param colors Colour of each point. */
  constructor(colors: readonly Color[], style: PointsStyle) {
    this.internals = getCesiumInternals();
    this.colors = colors;
    this.vertices = new Float32Array(colors.length * POINT_FLOATS);
    const scale = toUniform(style.scaleByDistance);
    const translucency = toUniform(style.translucencyByDistance);
    this.uniformMap = {
      u_pixelSize: () => style.pixelSize,
      u_scaleByDistance: () => scale,
      u_translucencyByDistance: () => translucency,
      u_morphHeight: () => this.morphHeight,
    };
  }

  /** The vertices changed. `radius` bounds the points' distance from the Earth's centre. */
  markDirty(radius: number): void {
    this.dirty = true;
    this.boundingSphere.radius = radius;
  }

  /** Called by the `PrimitiveCollection` once per frame, and on each pick. */
  update(frameState: FrameState): void {
    const { mode, passes } = frameState;
    if (this.failed || !this.internals || this.colors.length === 0) return;
    if (!passes.render && !passes.pick) return;

    // Contained like the orbits: an exception here would stop the render loop.
    try {
      this.prepare(frameState.context, this.internals);
      let command = this.commands.get(mode);
      if (!command) {
        command = this.createCommand(frameState.context, this.internals, mode);
        this.commands.set(mode, command);
      }
      frameState.commandList.push(command);
    } catch (error) {
      this.failed = true;
      console.error('[cesium-sgp4-viewer] points disabled: could not draw them', error);
    }
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  destroy(): void {
    this.vertexArray?.destroy();
    this.program?.destroy();
    for (const pickId of this.pickIds) pickId.destroy();
    this.destroyed = true;
  }

  private prepare(context: unknown, internals: CesiumInternals): void {
    if (this.vertexBuffer) {
      if (this.dirty) this.vertexBuffer.copyFromArrayView(this.vertices);
      this.dirty = false;
      return;
    }

    const colors = new Uint8Array(this.colors.length * COLOR_BYTES);
    const bytes: number[] = [];
    this.pickIds = this.colors.map((color, index) => {
      const object: PickedPoint = { primitive: this, index };
      const pickId = (context as { createPickId(object: object): PickId }).createPickId(object);
      colors.set(color.toBytes(bytes), index * COLOR_BYTES);
      colors.set(pickId.color.toBytes(bytes), index * COLOR_BYTES + 4);
      return pickId;
    });

    const { Buffer, BufferUsage } = internals;
    this.vertexBuffer = Buffer.createVertexBuffer({
      context,
      typedArray: this.vertices,
      usage: BufferUsage.DYNAMIC_DRAW,
    });
    const colorBuffer = Buffer.createVertexBuffer({
      context,
      typedArray: colors,
      usage: BufferUsage.STATIC_DRAW,
    });
    const float = (index: number, components: number, offset: number) => ({
      index,
      vertexBuffer: this.vertexBuffer!,
      componentsPerAttribute: components,
      componentDatatype: ComponentDatatype.FLOAT,
      offsetInBytes: offset * FLOAT_BYTES,
      strideInBytes: POINT_FLOATS * FLOAT_BYTES,
    });
    const byte = (index: number, offset: number) => ({
      index,
      vertexBuffer: colorBuffer,
      componentsPerAttribute: 4,
      componentDatatype: ComponentDatatype.UNSIGNED_BYTE,
      normalize: true,
      offsetInBytes: offset,
      strideInBytes: COLOR_BYTES,
    });
    const locations = POINT_ATTRIBUTE_LOCATIONS;
    // Destroying the vertex array destroys both buffers.
    this.vertexArray = new internals.VertexArray({
      context,
      attributes: [
        float(locations.positionHigh, 3, 0),
        float(locations.positionLow, 3, 3),
        float(locations.show, 1, 6),
        byte(locations.color, 0),
        byte(locations.pickColor, 4),
      ],
    });
    this.dirty = false;
  }

  private createCommand(context: unknown, internals: CesiumInternals, mode: SceneMode): unknown {
    this.program ??= internals.ShaderProgram.fromCache({
      context,
      vertexShaderSource: POINT_VERTEX_SHADER,
      fragmentShaderSource: POINT_FRAGMENT_SHADER,
      attributeLocations: POINT_ATTRIBUTE_LOCATIONS,
    });
    const is3D = mode === SceneMode.SCENE3D;
    return new internals.DrawCommand({
      owner: this,
      primitiveType: PrimitiveType.POINTS,
      vertexArray: this.vertexArray,
      count: this.colors.length,
      shaderProgram: this.program,
      uniformMap: this.uniformMap,
      renderState: internals.RenderState.fromCache({
        // On a map the points lie on the imagery, as the ground tracks do.
        depthTest: { enabled: mode !== SceneMode.SCENE2D },
        // Overlapping points blend, so a dense shell reads as a density.
        depthMask: false,
        // Typed `any` by Cesium: narrowed so it cannot leak further.
        blending: BlendingState.ALPHA_BLEND as unknown,
      }),
      pass: internals.Pass.OPAQUE,
      pickId: 'v_pickColor',
      modelMatrix: Matrix4.IDENTITY,
      // Outside 3D the shader projects the points itself: the bounding
      // sphere, in Earth-fixed coordinates, would not hold there.
      boundingVolume: is3D ? this.boundingSphere : undefined,
      cull: is3D,
    });
  }
}

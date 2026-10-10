import {
  BlendOption,
  BoundingSphere,
  type BufferPolyline,
  type BufferPolylineCollection,
  Cartesian3,
  type Color,
  ComponentDatatype,
  type JulianDate,
  Matrix3,
  Matrix4,
  type Scene,
  Transforms,
} from 'cesium';

import type { RingBatch } from '../../../../src/render/OrbitPrimitive.js';
import { RING_VERTEX_FLOATS } from '../../../../src/worker/protocol.js';
import type { BufferApi } from './cesiumBufferApi.js';
import { SceneModeGate } from './SceneModeGate.js';

/** The polylines of one satellite, in the collection of its colour group. */
interface SatelliteRuns {
  group: number;
  first: number;
  count: number;
}

const scratchRotation = new Matrix3();

/**
 * Every orbit of a catalog as 3D rings, one `BufferPolylineCollection` per
 * colour group, through Cesium's public API only.
 *
 * The rings stay in TEME, as the workers built them; each frame only the
 * collections' model matrix turns them under the Earth, so no vertex is ever
 * uploaded again until the rings are rebuilt. A ring that SGP4 broke becomes
 * one polyline per unbroken run.
 *
 * 3D only (see {@link SceneModeGate}): the 2D ground track is computed per
 * vertex on the GPU from the clock, which a polyline collection cannot express.
 * `OrbitPrimitive` keeps drawing it.
 *
 * Positions must stay 32-bit: Cesium's 64-bit path draws relative to the eye
 * and ignores the model matrix.
 */
export class BufferOrbitLayer {
  private readonly scene: Scene;
  private readonly api: BufferApi;
  private readonly colors: readonly Color[];
  private readonly drawOrder: readonly number[];
  private readonly polyline: BufferPolyline;
  private gates: SceneModeGate<BufferPolylineCollection>[] = [];
  /** Collection of each colour group, `undefined` for an empty group. */
  private collections: (BufferPolylineCollection | undefined)[] = [];
  /** Polylines of each catalog index, `undefined` without a ring. */
  private runs: (SatelliteRuns | undefined)[] = [];
  private visible: Uint8Array | null = null;
  private isShown = true;

  /**
   * @param colors Colour of each group, indexed by group code.
   * @param drawOrder Group codes in the order their collections are added.
   */
  constructor(
    scene: Scene,
    api: BufferApi,
    colors: readonly Color[],
    drawOrder: readonly number[],
  ) {
    this.scene = scene;
    this.api = api;
    this.colors = colors;
    this.drawOrder = drawOrder;
    this.polyline = new api.BufferPolyline();
  }

  get show(): boolean {
    return this.isShown;
  }

  set show(show: boolean) {
    this.isShown = show;
    for (const collection of this.collections) if (collection) collection.show = show;
  }

  /** Replaces the rings with new collections. */
  setBatches(batches: readonly RingBatch[]): void {
    this.release();

    const groupCount = this.colors.length;
    const polylineCount = new Uint32Array(groupCount);
    const vertexCount = new Uint32Array(groupCount);
    let radius = 0;
    for (const { rings, groups } of batches) {
      radius = Math.max(radius, rings.radius);
      forEachRun(rings, groups, (_, group, from, to) => {
        polylineCount[group] = polylineCount[group]! + 1;
        vertexCount[group] = vertexCount[group]! + (to - from) / 2 + 1;
      });
    }

    this.collections = this.colors.map((color, group) => {
      if (polylineCount[group] === 0) return undefined;
      return new this.api.BufferPolylineCollection({
        primitiveCountMax: polylineCount[group]!,
        vertexCountMax: vertexCount[group]!,
        positionDatatype: ComponentDatatype.FLOAT,
        // Given, so the collection never scans its vertices; a sphere around
        // the Earth's centre holds under any rotation.
        boundingVolume: new BoundingSphere(Cartesian3.ZERO, radius),
        blendOption: color.alpha < 1 ? BlendOption.TRANSLUCENT : BlendOption.OPAQUE,
        allowPicking: false,
        show: this.isShown,
      });
    });

    const materials = this.colors.map(
      (color) => new this.api.BufferPolylineMaterial({ color, width: 1 }),
    );
    const next = new Uint32Array(groupCount);
    // One scratch for every run: `add` copies the positions into the collection.
    let scratch = new Float32Array(0);
    this.runs = [];
    for (const batch of batches) {
      const { rings, start, groups } = batch;
      forEachRun(rings, groups, (j, group, from, to) => {
        const collection = this.collections[group]!;
        const length = ((to - from) / 2 + 1) * 3;
        if (scratch.length < length) scratch = new Float32Array(length);
        const positions = scratch.subarray(0, length);
        let o = 0;
        const copy = (vertex: number) => {
          const v = vertex * RING_VERTEX_FLOATS;
          positions[o++] = rings.vertices[v]!;
          positions[o++] = rings.vertices[v + 1]!;
          positions[o++] = rings.vertices[v + 2]!;
        };
        copy(rings.indices[from]!);
        for (let k = from + 1; k < to; k += 2) copy(rings.indices[k]!);

        const index = next[group]!;
        next[group] = index + 1;
        collection.add({ positions, material: materials[group] }, this.polyline);
        const runs = this.runs[start + j];
        if (runs) runs.count++;
        else this.runs[start + j] = { group, first: index, count: 1 };
      });
    }

    // Added in draw order, after whatever the scene already holds.
    for (const group of this.drawOrder) {
      const collection = this.collections[group];
      if (collection) this.gates.push(this.scene.primitives.add(new SceneModeGate(collection)));
    }
    this.applyVisibility(true);
  }

  /** Which catalog indices to draw (non-zero), or all of them with `null`. */
  setVisibility(visible: Uint8Array | null): void {
    this.visible = visible;
    this.applyVisibility(false);
  }

  /** Turns the TEME rings to the Earth-fixed frame of `time`. */
  update(time: JulianDate): void {
    if (this.gates.length === 0) return;
    const rotation = Transforms.computeTemeToPseudoFixedMatrix(time, scratchRotation);
    for (const collection of this.collections) {
      // A shared reference: the draw command reads this very matrix.
      if (collection)
        Matrix4.fromRotationTranslation(rotation, Cartesian3.ZERO, collection.modelMatrix);
    }
  }

  destroy(): void {
    this.release();
  }

  /** Writes `show` on the polylines whose satellite changed visibility (all with `force`). */
  private applyVisibility(force: boolean): void {
    const { visible, polyline } = this;
    this.runs.forEach((runs, i) => {
      if (!runs) return;
      const show = visible === null || visible[i] !== 0;
      const collection = this.collections[runs.group]!;
      collection.get(runs.first, polyline);
      if (!force && polyline.show === show) return;
      for (let k = runs.first; k < runs.first + runs.count; k++) {
        collection.get(k, polyline);
        polyline.show = show;
      }
    });
  }

  private release(): void {
    for (const gate of this.gates) this.scene.primitives.remove(gate);
    this.gates = [];
    this.collections = [];
    this.runs = [];
  }
}

/**
 * Calls `visit` for each unbroken run of `LINES` segments of each satellite:
 * `from` and `to` delimit the run's indices in `rings.indices`.
 */
const forEachRun = (
  rings: RingBatch['rings'],
  groups: Uint8Array,
  visit: (j: number, group: number, from: number, to: number) => void,
): void => {
  const { indices, indexStart, indexCount } = rings;
  for (let j = 0; j < groups.length; j++) {
    const end = indexStart[j]! + indexCount[j]!;
    let from = indexStart[j]!;
    for (let k = from + 2; k <= end; k += 2) {
      if (k === end || indices[k] !== indices[k - 1]) {
        if (k > from) visit(j, groups[j]!, from, k);
        from = k;
      }
    }
  }
};

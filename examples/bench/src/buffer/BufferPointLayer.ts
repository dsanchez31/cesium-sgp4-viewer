import {
  BlendOption,
  BoundingSphere,
  type BufferPoint,
  type BufferPointCollection,
  Cartesian3,
  type Color,
  ComponentDatatype,
  type Scene,
} from 'cesium';

import type { PositionSource } from '../../../../src/render/PositionSource.js';
import type { Vector3 } from '../../../../src/sgp4/propagate.js';
import type { BufferApi } from './cesiumBufferApi.js';
import { SceneModeGate } from './SceneModeGate.js';

const scratch: Vector3 = { x: 0, y: 0, z: 0 };

/**
 * Every satellite as one point of a single `BufferPointCollection`, in 3D only
 * (see {@link SceneModeGate}).
 *
 * Point `i` is catalog index `i`. Each frame writes every position into one
 * `Float32Array` and hands it over with a single `setPositions`, the position
 * only fast path of Cesium 1.146: no per-point object, no per-point setter.
 * `show` is written only when a point appears or disappears, since any
 * property change sends the collection down its slower full update.
 *
 * No `scaleByDistance` nor `translucencyByDistance`: `BufferPointMaterial` has
 * neither, so points keep a fixed size and opacity. Another reason the library
 * keeps `PointPrimitiveCollection` until Cesium adds them.
 */
export class BufferPointLayer {
  private readonly scene: Scene;
  private readonly collection: BufferPointCollection;
  private readonly gate: SceneModeGate<BufferPointCollection>;
  private readonly point: BufferPoint;
  private readonly positions: Float32Array<ArrayBuffer>;
  /** Whether each point is currently shown, as last written to the collection. */
  private readonly shown: Uint8Array;

  constructor(
    scene: Scene,
    api: BufferApi,
    count: number,
    style: { pixelSize: number; colorOf: (i: number) => Color },
  ) {
    this.scene = scene;
    this.positions = new Float32Array(count * 3);
    this.shown = new Uint8Array(count);
    this.point = new api.BufferPoint();
    this.collection = new api.BufferPointCollection({
      primitiveCountMax: count,
      // Samples are Float32 already: a 64-bit buffer would only add the
      // high/low split on every upload.
      positionDatatype: ComponentDatatype.FLOAT,
      // Translucent: overlapping points add up to brightness, so a dense shell
      // reads as a density rather than a flat disc.
      blendOption: BlendOption.TRANSLUCENT,
      // Given, so the collection never scans its positions to bound them; its
      // radius follows the farthest point in `update`.
      boundingVolume: new BoundingSphere(Cartesian3.ZERO, 0),
    });

    const material = new api.BufferPointMaterial({ size: style.pixelSize });
    const position = new Cartesian3();
    for (let i = 0; i < count; i++) {
      material.color = style.colorOf(i);
      this.collection.add({ position, material, show: false }, this.point);
    }
    this.gate = scene.primitives.add(new SceneModeGate(this.collection));
  }

  get show(): boolean {
    return this.collection.show;
  }

  set show(show: boolean) {
    this.collection.show = show;
  }

  /**
   * Moves every point to its position at `ms`, hiding the ones `isVisible`
   * rejects or `source` cannot place.
   */
  update(ms: number, source: PositionSource, isVisible: (i: number) => boolean): void {
    const { positions, shown, collection, point } = this;
    let maxRadiusSquared = 0;

    for (let i = 0, o = 0; i < shown.length; i++, o += 3) {
      const position = isVisible(i) ? source.positionAt(i, ms, scratch) : null;
      const isShown = position !== null;
      if (position) {
        positions[o] = position.x;
        positions[o + 1] = position.y;
        positions[o + 2] = position.z;
        maxRadiusSquared = Math.max(
          maxRadiusSquared,
          position.x * position.x + position.y * position.y + position.z * position.z,
        );
      }
      if (isShown !== (shown[i] === 1)) {
        shown[i] = isShown ? 1 : 0;
        collection.get(i, point);
        point.show = isShown;
      }
    }

    collection.setPositions(positions, 0, shown.length);
    // A shared reference: the draw command reads this very sphere.
    collection.boundingVolume.radius = Math.sqrt(maxRadiusSquared);
  }

  isShown(i: number): boolean {
    return this.shown[i] === 1;
  }

  /** Position of point `i` as last written, in `result`. */
  positionOf(i: number, result: Cartesian3): Cartesian3 {
    const { positions } = this;
    return Cartesian3.fromElements(
      positions[i * 3]!,
      positions[i * 3 + 1]!,
      positions[i * 3 + 2]!,
      result,
    );
  }

  /** Catalog index of a `scene.pick` result, if it is one of these points. */
  indexOf(picked: unknown): number | undefined {
    const object = picked as { collection?: unknown; index?: unknown } | undefined;
    return object?.collection === this.collection && typeof object.index === 'number'
      ? object.index
      : undefined;
  }

  destroy(): void {
    this.scene.primitives.remove(this.gate);
  }
}

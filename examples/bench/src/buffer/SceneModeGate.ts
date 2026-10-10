import { SceneMode } from 'cesium';

import type { FrameState } from '../../../../src/render/cesiumInternals.js';

/** What `PrimitiveCollection` asks of a child. */
export interface ScenePrimitive {
  update(frameState: unknown): void;
  isDestroyed(): boolean;
  destroy(): void;
}

/**
 * Lets a primitive see only the frames rendered in `SceneMode.SCENE3D`.
 *
 * Cesium's buffer collections (`BufferPointCollection`, ...) only project
 * positions for the 3D globe: in 2D, Columbus view or during a morph they log a
 * warning and draw Earth-fixed coordinates as if they were map coordinates.
 * Pick passes go through `update` too, so a gated primitive is never picked
 * outside 3D either.
 *
 * This is why the library keeps its per-object renderers for now. Durable fix:
 * 2D, Columbus view and morph support in `BufferPrimitiveCollection` upstream
 * (CesiumGS/cesium#13585). Once a Cesium release ships it, these layers can
 * move to the library and this gate can go.
 */
export class SceneModeGate<T extends ScenePrimitive> {
  readonly inner: T;

  constructor(inner: T) {
    this.inner = inner;
  }

  update(frameState: FrameState): void {
    if (frameState.mode === SceneMode.SCENE3D) this.inner.update(frameState);
  }

  isDestroyed(): boolean {
    return this.inner.isDestroyed();
  }

  destroy(): void {
    this.inner.destroy();
  }
}

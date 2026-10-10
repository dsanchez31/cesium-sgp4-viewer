import type { Vector3 } from '../sgp4/propagate.js';

/**
 * Where the point layers read each satellite's position: the `TrackStore` in
 * the library, synthetic orbits in the benchmark.
 */
export interface PositionSource {
  /** Earth-fixed position of satellite `i` at `ms`, or `null` when it has none. */
  positionAt(i: number, ms: number, out: Vector3): Vector3 | null;
}

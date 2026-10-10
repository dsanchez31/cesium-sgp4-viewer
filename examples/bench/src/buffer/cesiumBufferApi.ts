import type {
  BufferPoint,
  BufferPointCollection,
  BufferPointMaterial,
  BufferPolyline,
  BufferPolylineCollection,
  BufferPolylineMaterial,
} from 'cesium';
import * as Cesium from 'cesium';

/*
 * CesiumJS's buffer collections, read off the namespace rather than imported by
 * name: the peer range starts at 1.140, and a named import of an export that a
 * consumer's Cesium lacks would fail their build. The bulk `setPositions` this
 * library needs arrived in 1.146 (CesiumGS/cesium#13511).
 */

export interface BufferApi {
  BufferPoint: typeof BufferPoint;
  BufferPointCollection: typeof BufferPointCollection;
  BufferPointMaterial: typeof BufferPointMaterial;
  BufferPolyline: typeof BufferPolyline;
  BufferPolylineCollection: typeof BufferPolylineCollection;
  BufferPolylineMaterial: typeof BufferPolylineMaterial;
}

const REQUIRED = [
  'BufferPoint',
  'BufferPointCollection',
  'BufferPointMaterial',
  'BufferPolyline',
  'BufferPolylineCollection',
  'BufferPolylineMaterial',
] as const;

let checked: BufferApi | null | undefined;

/**
 * The buffer collections, or `null` when this Cesium build lacks them or their
 * bulk `setPositions`. Callers then keep the per-object primitives.
 */
export const getBufferApi = (): BufferApi | null => {
  if (checked !== undefined) return checked;
  const namespace = Cesium as unknown as Record<string, unknown>;
  const complete = REQUIRED.every((name) => namespace[name] !== undefined);
  const api = namespace as unknown as BufferApi;
  checked =
    complete &&
    typeof api.BufferPointCollection.prototype.setPositions === 'function' &&
    typeof api.BufferPolylineCollection.prototype.setPositions === 'function'
      ? api
      : null;
  return checked;
};

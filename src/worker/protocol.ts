/*
 * Messages between the main thread and the propagation workers. No Cesium
 * import anywhere on the worker side: it would add megabytes to the worker.
 */

/** Floats per ring vertex: TEME x, y, z (metres), `tau`, period (seconds). */
export const RING_VERTEX_FLOATS = 5;

export interface LoadMessage {
  type: 'load';
  /** Line 1 and line 2 of each satellite of the shard, one after the other. */
  tles: string[];
}

export interface SampleMessage {
  type: 'sample';
  requestId: number;
  startMs: number;
  stopMs: number;
}

/** Rebuild the rings around `epochMs`. */
export interface RingsMessage {
  type: 'rings';
  requestId: number;
  epochMs: number;
}

export type ToWorker = LoadMessage | SampleMessage | RingsMessage;

/**
 * One revolution of every orbit of a shard, as `LINES`, ready for the GPU.
 *
 * Each vertex is {@link RING_VERTEX_FLOATS} floats: the TEME position, then
 * `tau`, the time from `epochMs` at which the satellite stands there, then the
 * orbital period. The 2D ground track needs both timings.
 *
 * The segments of satellite `j` of the shard are the `indexCount[j]` indices
 * starting at `indexStart[j]`, so any subset of rings can be drawn by copying
 * index ranges, without touching the vertices.
 */
export interface RingBuffers {
  epochMs: number;
  vertices: Float32Array<ArrayBuffer>;
  indices: Uint32Array<ArrayBuffer>;
  indexStart: Uint32Array<ArrayBuffer>;
  indexCount: Uint32Array<ArrayBuffer>;
  /** Distance of the farthest vertex from the Earth's centre, metres. */
  radius: number;
}

/**
 * A shard's samples, packed so that every array can be transferred.
 *
 * Satellite `j` of the shard has `counts[j]` Earth-fixed positions (x, y, z in
 * metres, `NaN` where SGP4 failed), starting at position `offsets[j]` of
 * `positions`, the first at `firstMs[j]` and then every `stepMs[j]`. A count of
 * 0 means the satellite could not be propagated over the window.
 */
export interface SampleResult {
  type: 'sampled';
  requestId: number;
  offsets: Uint32Array<ArrayBuffer>;
  counts: Uint32Array<ArrayBuffer>;
  firstMs: Float64Array<ArrayBuffer>;
  stepMs: Float64Array<ArrayBuffer>;
  positions: Float32Array<ArrayBuffer>;
}

export interface RingsResult {
  type: 'rings';
  requestId: number;
  rings: RingBuffers;
}

export interface WorkerFailure {
  type: 'error';
  requestId: number | null;
  message: string;
}

export type FromWorker = SampleResult | RingsResult | WorkerFailure;

/** Every buffer of a result, for the transfer list of `postMessage`. */
export const transferablesOf = (result: SampleResult | RingsResult): Transferable[] => {
  if (result.type === 'rings') {
    const { vertices, indices, indexStart, indexCount } = result.rings;
    return [vertices.buffer, indices.buffer, indexStart.buffer, indexCount.buffer];
  }
  const { offsets, counts, firstMs, stepMs, positions } = result;
  return [offsets.buffer, counts.buffer, firstMs.buffer, stepMs.buffer, positions.buffer];
};

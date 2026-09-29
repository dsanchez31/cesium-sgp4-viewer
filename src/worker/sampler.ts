import { type SatRec, twoline2satrec } from 'satellite.js';

import { gridRange, ringSegments, sampleStepMs } from '../sampling/grid.js';
import { gmstAt, propagateTeme, temeToFixed } from '../sgp4/propagate.js';
import type { RingBuffers, SampleResult } from './protocol.js';
import { buildRings, type RingSpec } from './rings.js';

/** Fewer valid samples than this over a window, and the satellite counts as failed. */
const MIN_VALID_SAMPLES = 2;

interface Track extends RingSpec {
  stepMs: number;
  /** Grid index of the first cached sample, which sits at `first · stepMs`. */
  first: number;
  count: number;
  valid: number;
  samples: Float32Array | null;
}

const scratch = { x: 0, y: 0, z: 0 };

/**
 * Propagates one shard of a catalog, keeping each satellite's samples between
 * calls.
 *
 * The window follows the playhead, so two consecutive requests overlap almost
 * entirely. Samples sit on a fixed grid, so the overlap is copied rather than
 * propagated again: moving the window costs SGP4 only for the new stretch.
 */
export class ShardSampler {
  private readonly tracks: Track[];

  /** `tles` holds line 1 and line 2 of each satellite, one after the other. */
  constructor(tles: readonly string[]) {
    this.tracks = [];
    for (let i = 0; i < tles.length; i += 2) {
      const satrec: SatRec = twoline2satrec(tles[i]!, tles[i + 1]!);
      const periodSeconds = ((2 * Math.PI) / satrec.no) * 60;
      this.tracks.push({
        satrec,
        periodSeconds,
        segments: ringSegments(satrec.ecco),
        stepMs: sampleStepMs(periodSeconds, satrec.ecco),
        first: 0,
        count: 0,
        valid: 0,
        samples: null,
      });
    }
  }

  get size(): number {
    return this.tracks.length;
  }

  /** Earth-fixed samples of every satellite over `[startMs, stopMs]`. */
  sample(requestId: number, startMs: number, stopMs: number): SampleResult {
    const n = this.tracks.length;
    const offsets = new Uint32Array(n);
    const counts = new Uint32Array(n);
    const firstMs = new Float64Array(n);
    const stepMs = new Float64Array(n);

    let total = 0;
    this.tracks.forEach((track, j) => {
      this.resample(track, startMs, stopMs);
      if (track.valid < MIN_VALID_SAMPLES) return;
      offsets[j] = total;
      counts[j] = track.count;
      firstMs[j] = track.first * track.stepMs;
      stepMs[j] = track.stepMs;
      total += track.count;
    });

    // A copy of the cache, which stays here for the next request: the copy is
    // what gets transferred.
    const positions = new Float32Array(total * 3);
    this.tracks.forEach((track, j) => {
      if (counts[j]! > 0) positions.set(track.samples!, offsets[j]! * 3);
    });

    return { type: 'sampled', requestId, offsets, counts, firstMs, stepMs, positions };
  }

  rings(epochMs: number): RingBuffers {
    return buildRings(this.tracks, epochMs);
  }

  private resample(track: Track, startMs: number, stopMs: number): void {
    const { first, last } = gridRange(startMs, stopMs, track.stepMs);
    const count = last - first + 1;
    const previous = track.samples;
    if (previous && first === track.first && count === track.count) return;

    // A window of the same width moves in place: the overlap slides in one copy,
    // and only the new stretch is propagated.
    const samples = previous?.length === count * 3 ? previous : new Float32Array(count * 3);
    const keepFrom = Math.max(first, track.first);
    const keepTo = previous ? Math.min(last + 1, track.first + track.count) : keepFrom;
    if (previous && keepFrom < keepTo) {
      const from = (keepFrom - track.first) * 3;
      const to = (keepTo - track.first) * 3;
      const target = (keepFrom - first) * 3;
      if (samples === previous) samples.copyWithin(target, from, to);
      else samples.set(previous.subarray(from, to), target);
    }

    let valid = 0;
    for (let n = 0; n < count; n++) {
      const k = first + n;
      const o = n * 3;
      if (k < keepFrom || k >= keepTo) {
        const ms = k * track.stepMs;
        const teme = propagateTeme(track.satrec, ms, scratch);
        if (teme) {
          temeToFixed(teme, gmstAt(ms), teme);
          samples[o] = teme.x;
          samples[o + 1] = teme.y;
          samples[o + 2] = teme.z;
        } else {
          samples.fill(NaN, o, o + 3);
        }
      }
      if (!Number.isNaN(samples[o])) valid++;
    }

    track.first = first;
    track.count = count;
    track.valid = valid;
    track.samples = samples;
  }
}

import type { Vector3 } from '../sgp4/propagate.js';
import { INTERPOLATION_NODES } from './grid.js';

const factorial = (k: number): number => (k <= 1 ? 1 : k * factorial(k - 1));

/**
 * `1 / ∏(j − m)` over `m ≠ j`: the constant part of the weight of node `j`,
 * for each node count up to {@link INTERPOLATION_NODES}.
 */
const INVERSE_DENOMINATORS = Array.from({ length: INTERPOLATION_NODES + 1 }, (_, n) =>
  Float64Array.from(
    { length: n },
    (_, j) => ((n - 1 - j) % 2 === 0 ? 1 : -1) / (factorial(j) * factorial(n - 1 - j)),
  ),
);

/** `∏(t − m)` over `m < j`, for each node `j`. */
const prefix = new Float64Array(INTERPOLATION_NODES);

/**
 * Evaluates a trajectory sampled on a uniform grid.
 *
 * `samples` holds `count` positions (x, y, z interleaved) starting at float
 * index `offset * 3`, the first one at `firstMs` and then every `stepMs`. The
 * value at `ms` is the Lagrange polynomial through the {@link
 * INTERPOLATION_NODES} samples around it: with 36 samples per revolution it
 * stays within a few metres of SGP4, at a fraction of its cost.
 *
 * Returns `null` outside the samples, and when a node is `NaN` (SGP4 failed
 * there): no position rather than an invented one.
 */
export const interpolateSamples = (
  samples: Float32Array,
  offset: number,
  count: number,
  firstMs: number,
  stepMs: number,
  ms: number,
  out: Vector3,
): Vector3 | null => {
  const u = (ms - firstMs) / stepMs;
  if (!(u >= 0 && u <= count - 1)) return null;

  const nodes = Math.min(INTERPOLATION_NODES, count);
  // The nodes around `u`, centred where possible, shifted inwards at the ends.
  const first = Math.min(Math.max(Math.floor(u) - (nodes >> 1) + 1, 0), count - nodes);
  const t = u - first;

  // Each weight is `∏(t − m)` over `m ≠ j`, from running products on either
  // side of `j`, times a constant: no division, and exact on a node.
  const inverse = INVERSE_DENOMINATORS[nodes]!;
  for (let j = 0, product = 1; j < nodes; j++) {
    prefix[j] = product;
    product *= t - j;
  }

  let x = 0;
  let y = 0;
  let z = 0;
  let suffix = 1;
  for (let j = nodes - 1; j >= 0; j--) {
    const weight = prefix[j]! * suffix * inverse[j]!;
    const base = (offset + first + j) * 3;
    x += weight * samples[base]!;
    y += weight * samples[base + 1]!;
    z += weight * samples[base + 2]!;
    suffix *= t - j;
  }

  if (Number.isNaN(x + y + z)) return null;
  out.x = x;
  out.y = y;
  out.z = z;
  return out;
};

import { EARTH_EQUATORIAL_RADIUS, EARTH_MU, MS_PER_SECOND } from '../../../src/constants.js';
import { ORBIT_REGIMES, type OrbitRegime, regimeCode } from '../../../src/orbit/regime.js';
import type { PositionSource } from '../../../src/render/PositionSource.js';
import { ringSegments } from '../../../src/sampling/grid.js';
import { gmstAt, type Vector3 } from '../../../src/sgp4/propagate.js';
import { RING_VERTEX_FLOATS, type RingBuffers } from '../../../src/worker/protocol.js';

/*
 * A deterministic, analytic stand-in for a catalog: Kepler orbits drawn from a
 * mix close to the public catalog's. Both renderers read the very same
 * positions, so any difference between runs comes from the render path.
 */

/** Share of each regime, roughly that of the CelesTrak catalog. */
const REGIME_SHARE: Readonly<Record<OrbitRegime, number>> = {
  LEO: 0.86,
  MEO: 0.04,
  GEO: 0.06,
  HEO: 0.04,
};

/** Floats per orbit: a, e, n, M0, then the perifocal unit vectors P and Q. */
const ORBIT_FLOATS = 10;
const DEGREE = Math.PI / 180;

/** Small, seedable PRNG (mulberry32): the same catalog on every run. */
const random = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
};

interface Shape {
  semiMajorAxis: number;
  eccentricity: number;
  inclination: number;
}

const shapeOf = (regime: OrbitRegime, next: () => number): Shape => {
  const between = (min: number, max: number) => min + (max - min) * next();
  switch (regime) {
    case 'LEO':
      return {
        semiMajorAxis: EARTH_EQUATORIAL_RADIUS + between(400e3, 1_200e3),
        eccentricity: between(0, 0.01),
        inclination: [53, 70, 97.6, between(0, 100)][Math.floor(next() * 4)]! * DEGREE,
      };
    case 'MEO':
      return {
        semiMajorAxis: EARTH_EQUATORIAL_RADIUS + between(19_000e3, 23_500e3),
        eccentricity: between(0, 0.02),
        inclination: between(54, 65) * DEGREE,
      };
    case 'GEO':
      return {
        semiMajorAxis: 42_164e3,
        eccentricity: between(0, 0.001),
        inclination: 0.05 * DEGREE,
      };
    case 'HEO':
      return next() < 0.5
        ? { semiMajorAxis: 26_560e3, eccentricity: 0.72, inclination: 63.4 * DEGREE }
        : { semiMajorAxis: 24_400e3, eccentricity: 0.73, inclination: between(7, 28) * DEGREE };
  }
};

export class SyntheticCatalog implements PositionSource {
  readonly count: number;
  /** Regime code of each satellite. */
  readonly regimes: Uint8Array;
  /** Time origin of the mean anomalies and of the rings, Unix milliseconds. */
  readonly epochMs: number;
  private readonly orbits: Float64Array;
  // The sidereal angle of the last instant asked: the same for the whole frame.
  private thetaMs = Number.NaN;
  private cosTheta = 1;
  private sinTheta = 0;

  constructor(count: number, epochMs: number, seed = 1) {
    this.count = count;
    this.epochMs = epochMs;
    this.regimes = new Uint8Array(count);
    this.orbits = new Float64Array(count * ORBIT_FLOATS);
    const next = random(seed);

    for (let i = 0; i < count; i++) {
      let pick = next();
      let regime: OrbitRegime = 'LEO';
      for (const candidate of ORBIT_REGIMES) {
        pick -= REGIME_SHARE[candidate];
        if (pick < 0) {
          regime = candidate;
          break;
        }
      }
      this.regimes[i] = regimeCode(regime);

      const { semiMajorAxis: a, eccentricity: e, inclination } = shapeOf(regime, next);
      const raan = next() * 2 * Math.PI;
      const perigee = next() * 2 * Math.PI;
      const [cO, sO, cw, sw, ci, si] = [
        Math.cos(raan),
        Math.sin(raan),
        Math.cos(perigee),
        Math.sin(perigee),
        Math.cos(inclination),
        Math.sin(inclination),
      ];
      const o = i * ORBIT_FLOATS;
      this.orbits.set(
        [
          a,
          e,
          Math.sqrt(EARTH_MU / (a * a * a)),
          next() * 2 * Math.PI,
          cO * cw - sO * sw * ci,
          sO * cw + cO * sw * ci,
          sw * si,
          -cO * sw - sO * cw * ci,
          -sO * sw + cO * cw * ci,
          cw * si,
        ],
        o,
      );
    }
  }

  /** Earth-fixed position of satellite `i` at `ms`. Never `null`. */
  positionAt(i: number, ms: number, out: Vector3): Vector3 {
    this.inertialAt(i, (ms - this.epochMs) / MS_PER_SECOND, out);
    if (ms !== this.thetaMs) {
      const theta = gmstAt(ms);
      this.thetaMs = ms;
      this.cosTheta = Math.cos(theta);
      this.sinTheta = Math.sin(theta);
    }
    const c = this.cosTheta;
    const s = this.sinTheta;
    const { x, y } = out;
    out.x = c * x + s * y;
    out.y = c * y - s * x;
    return out;
  }

  periodSeconds(i: number): number {
    return (2 * Math.PI) / this.orbits[i * ORBIT_FLOATS + 2]!;
  }

  /** One revolution of every orbit around `epochMs`, laid out as the workers do. */
  rings(): RingBuffers {
    const { count } = this;
    let vertexCapacity = 0;
    for (let i = 0; i < count; i++) {
      vertexCapacity += ringSegments(this.orbits[i * ORBIT_FLOATS + 1]!) + 1;
    }
    const vertices = new Float32Array(vertexCapacity * RING_VERTEX_FLOATS);
    const indices = new Uint32Array((vertexCapacity - count) * 2);
    const indexStart = new Uint32Array(count);
    const indexCount = new Uint32Array(count);
    const position: Vector3 = { x: 0, y: 0, z: 0 };
    let vertex = 0;
    let index = 0;
    let radius = 0;

    for (let i = 0; i < count; i++) {
      const segments = ringSegments(this.orbits[i * ORBIT_FLOATS + 1]!);
      const period = this.periodSeconds(i);
      indexStart[i] = index;
      for (let k = 0; k <= segments; k++) {
        const tau = (k / segments - 0.5) * period;
        this.inertialAt(i, tau, position);
        const o = vertex * RING_VERTEX_FLOATS;
        vertices[o] = position.x;
        vertices[o + 1] = position.y;
        vertices[o + 2] = position.z;
        vertices[o + 3] = tau;
        vertices[o + 4] = period;
        radius = Math.max(radius, Math.hypot(position.x, position.y, position.z));
        if (k > 0) {
          indices[index++] = vertex - 1;
          indices[index++] = vertex;
        }
        vertex++;
      }
      indexCount[i] = index - indexStart[i]!;
    }

    return { epochMs: this.epochMs, vertices, indices, indexStart, indexCount, radius };
  }

  /** Inertial (TEME-like) position `t` seconds after the epoch. */
  private inertialAt(i: number, t: number, out: Vector3): void {
    const o = i * ORBIT_FLOATS;
    const orbits = this.orbits;
    const a = orbits[o]!;
    const e = orbits[o + 1]!;
    const meanAnomaly = orbits[o + 3]! + orbits[o + 2]! * t;

    // Kepler's equation by Newton; three steps are plenty below e = 0.75.
    let E = e < 0.8 ? meanAnomaly : Math.PI;
    for (let k = 0; k < 3 && e > 0; k++) {
      E -= (E - e * Math.sin(E) - meanAnomaly) / (1 - e * Math.cos(E));
    }
    const px = a * (Math.cos(E) - e);
    const qy = a * Math.sqrt(1 - e * e) * Math.sin(E);

    out.x = px * orbits[o + 4]! + qy * orbits[o + 7]!;
    out.y = px * orbits[o + 5]! + qy * orbits[o + 8]!;
    out.z = px * orbits[o + 6]! + qy * orbits[o + 9]!;
  }
}

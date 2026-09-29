import { describe, expect, it } from 'vitest';

import { hidePoint, POINT_FLOATS, writePoint } from './pointShaders.js';

describe('writePoint', () => {
  it('splits each coordinate like Cesium, high on a 65,536 m grid', () => {
    const vertices = new Float32Array(2 * POINT_FLOATS);
    const [x, y, z] = [6_778_137.25, -4_123_456.5, 131_072];
    writePoint(vertices, 1, x, y, z);

    const v = POINT_FLOATS;
    expect([vertices[v], vertices[v + 1], vertices[v + 2]]).toEqual([
      6_750_208, -4_063_232, 131_072,
    ]);
    expect(vertices[v]! + vertices[v + 3]!).toBe(x);
    expect(vertices[v + 1]! + vertices[v + 4]!).toBe(y);
    expect(vertices[v + 5]).toBe(0);
    expect(vertices[v + 6]).toBe(1);
    // The first point is untouched.
    expect([...vertices.subarray(0, POINT_FLOATS)].every((f) => f === 0)).toBe(true);

    hidePoint(vertices, 1);
    expect(vertices[v + 6]).toBe(0);
  });
});

import { EARTH_ROTATION_RATE } from '../constants.js';

/*
 * GLSL for the orbit primitive. Cesium adds its own prelude (the `czm_*`
 * built-ins, log depth, WebGL 1 translation) to both stages.
 *
 * Vertex attributes (see `RING_VERTEX_FLOATS`): `position` is the TEME point in
 * metres, `timing` is `(tau, period)` in seconds, `tau` being when the
 * satellite stands on the vertex, relative to the ring epoch.
 */

export const ATTRIBUTE_LOCATIONS = { position: 0, timing: 1 } as const;

/**
 * Geodetic longitude, latitude (Bowring) and height above the WGS-84
 * ellipsoid of an Earth-fixed point, in radians and metres: what Cesium's
 * default `GeographicProjection` maps to 2D and Columbus view coordinates.
 */
export const GEODETIC_GLSL = /* glsl */ `
const float WGS84_A = 6378137.0;
const float WGS84_B = 6356752.314245179;
const float WGS84_E2 = 6.69437999014e-3;
const float WGS84_EP2 = 6.73949674228e-3;

vec3 geodetic(vec3 p) {
  float r = length(p.xy);
  float beta = atan(WGS84_A * p.z, WGS84_B * r);
  float sb = sin(beta);
  float cb = cos(beta);
  float lat = atan(p.z + WGS84_EP2 * WGS84_B * sb * sb * sb, r - WGS84_E2 * WGS84_A * cb * cb * cb);
  float sl = sin(lat);
  float height = r * cos(lat) + p.z * sl - WGS84_A * sqrt(1.0 - WGS84_E2 * sl * sl);
  return vec3(atan(p.y, p.x), lat, height);
}
`;

/**
 * 3D: the ring as it is, turned from TEME to the Earth-fixed frame by the
 * model matrix, which the primitive updates every frame.
 */
export const VERTEX_SHADER_3D = /* glsl */ `
in vec3 position;
in vec2 timing;

void main() {
  gl_Position = czm_modelViewProjection * vec4(position, 1.0);
}
`;

/** `czm_gammaCorrect` keeps colours right when the scene renders in HDR. */
export const FRAGMENT_SHADER_3D = /* glsl */ `
uniform vec4 u_color;

void main() {
  out_FragColor = czm_gammaCorrect(u_color);
}
`;

/**
 * 2D: the ground track, computed on the GPU from the same buffers.
 *
 * On a map an inertial ring means nothing; what matters is the point under the
 * satellite at each moment of the revolution around now. For each vertex the
 * shader takes the pass nearest the clock (`u_dt`, seconds from the ring
 * epoch), turns the TEME point by the Earth's rotation at that moment (sidereal
 * angle linearised from `u_theta0`, exact to well under a pixel over the hour a
 * ring lives), and projects the geodetic longitude and latitude (Bowring) the
 * way Cesium's default `GeographicProjection` does.
 *
 * Cesium's 2D world coordinates are `(height, easting, northing)`.
 *
 * Longitude wraps at ±180°, and the pass index changes half a revolution away
 * from the satellite: a segment across either jump would streak across the map.
 * Each quantity is sent twice, as is and shifted by half a turn, and the
 * fragment shader drops fragments where the first varies much faster than the
 * second (the seam technique of Tarini, 2012).
 */
export const VERTEX_SHADER_2D = /* glsl */ `
in vec3 position;
in vec2 timing;

uniform float u_dt;
uniform float u_theta0;

out float v_lon;
out float v_lonShifted;
out float v_phase;
out float v_phaseShifted;

const float OMEGA = ${EARTH_ROTATION_RATE.toExponential(15)};
${GEODETIC_GLSL}
void main() {
  float tau = timing.x;
  float period = timing.y;
  float t = tau + period * floor((u_dt - tau) / period + 0.5);

  float theta = u_theta0 + OMEGA * t;
  float c = cos(theta);
  float s = sin(theta);
  vec3 p = vec3(c * position.x + s * position.y, c * position.y - s * position.x, position.z);

  vec3 g = geodetic(p);
  float lon = g.x;
  float lat = g.y;

  v_lon = lon;
  v_lonShifted = lon < 0.0 ? lon + czm_twoPi : lon;
  float phase = (t - u_dt) / period;
  v_phase = phase;
  v_phaseShifted = phase < 0.0 ? phase + 1.0 : phase;

  gl_Position = czm_modelViewProjection * vec4(0.0, lon * WGS84_A, lat * WGS84_A, 1.0);
}
`;

export const FRAGMENT_SHADER_2D = /* glsl */ `
#ifdef GL_OES_standard_derivatives
#extension GL_OES_standard_derivatives : enable
#endif

uniform vec4 u_color;

in float v_lon;
in float v_lonShifted;
in float v_phase;
in float v_phaseShifted;

void main() {
  if (fwidth(v_lon) > 2.0 * fwidth(v_lonShifted)) discard;
  if (fwidth(v_phase) > 2.0 * fwidth(v_phaseShifted)) discard;
  out_FragColor = czm_gammaCorrect(u_color);
}
`;

import { GEODETIC_GLSL } from './orbitShaders.js';

/*
 * GLSL for the points primitive. One vertex per satellite, drawn as `POINTS`.
 *
 * Vertex attributes (see `POINT_FLOATS`): the Earth-fixed position split into
 * high and low parts, as Cesium encodes positions drawn relative to the eye so
 * they hold still at any zoom, and `show` (0 or 1). Colour and pick colour come
 * from a second, static buffer.
 */

/** Floats per point in the vertex buffer: high x, y, z, low x, y, z, show. */
export const POINT_FLOATS = 7;

/**
 * Writes point `i` at `(x, y, z)` metres, shown. Each coordinate is split the
 * way Cesium's `EncodedCartesian3` does, a high part on a 65,536 m grid and the
 * rest, which is what `czm_translateRelativeToEye` subtracts the camera from.
 */
export const writePoint = (vertices: Float32Array, i: number, x: number, y: number, z: number) => {
  const v = i * POINT_FLOATS;
  const hx = Math.trunc(x / 65_536) * 65_536;
  const hy = Math.trunc(y / 65_536) * 65_536;
  const hz = Math.trunc(z / 65_536) * 65_536;
  vertices[v] = hx;
  vertices[v + 1] = hy;
  vertices[v + 2] = hz;
  vertices[v + 3] = x - hx;
  vertices[v + 4] = y - hy;
  vertices[v + 5] = z - hz;
  vertices[v + 6] = 1;
};

/** Hides point `i`. */
export const hidePoint = (vertices: Float32Array, i: number) => {
  vertices[i * POINT_FLOATS + 6] = 0;
};

export const POINT_ATTRIBUTE_LOCATIONS = {
  positionHigh: 0,
  positionLow: 1,
  show: 2,
  color: 3,
  pickColor: 4,
} as const;

/**
 * In 3D the point is placed relative to the eye. In 2D and Columbus view it is
 * projected the way Cesium's `GeographicProjection` does, height dropped on the
 * map, into Cesium's `(height, easting, northing)` world coordinates. During a
 * morph it moves between that projection and 3D with `czm_morphTime`, as
 * Cesium's own primitives do, with its height scaled by `u_morphHeight`.
 *
 * Size and opacity follow the camera distance like `PointPrimitive`'s
 * `scaleByDistance` and `translucencyByDistance`, with 3 pixels of padding for
 * the anti-aliased edge. A hidden point is collapsed to nothing.
 */
export const POINT_VERTEX_SHADER = /* glsl */ `
in vec3 positionHigh;
in vec3 positionLow;
in float show;
in vec4 color;
in vec4 pickColor;

uniform float u_pixelSize;
uniform vec4 u_scaleByDistance;
uniform vec4 u_translucencyByDistance;
uniform float u_morphHeight;

out vec4 v_color;
out vec4 v_pickColor;
out float v_pixelDistance;

${GEODETIC_GLSL}

void main() {
  vec4 positionEC;
  float distanceSquared;
  if (czm_sceneMode == czm_sceneMode3D) {
    positionEC = czm_modelViewRelativeToEye * czm_translateRelativeToEye(positionHigh, positionLow);
    distanceSquared = dot(positionEC.xyz, positionEC.xyz);
  } else {
    vec3 position = positionHigh + positionLow;
    vec3 g = geodetic(position);
    float height = g.z;
    if (czm_sceneMode == czm_sceneMode2D) height = 0.0;
    if (czm_sceneMode == czm_sceneModeMorphing) height *= u_morphHeight;
    vec4 projected = vec4(height, g.x * WGS84_A, g.y * WGS84_A, 1.0);
    if (czm_sceneMode == czm_sceneModeMorphing) {
      projected = czm_columbusViewMorph(projected, vec4(position, 1.0), czm_morphTime);
    }
    positionEC = czm_modelView * projected;
    distanceSquared = czm_sceneMode == czm_sceneMode2D
      ? czm_eyeHeight2D.y
      : dot(positionEC.xyz, positionEC.xyz);
  }

  float size = u_pixelSize * czm_pixelRatio * czm_nearFarScalar(u_scaleByDistance, distanceSquared) + 3.0;
  gl_Position = czm_projection * positionEC * show;
  gl_PointSize = size * show;

  v_color = color;
  v_color.a *= czm_nearFarScalar(u_translucencyByDistance, distanceSquared);
  v_pickColor = pickColor;
  v_pixelDistance = 2.0 / size;
}
`;

/** A disc with an anti-aliased edge, like `PointPrimitive`'s. */
export const POINT_FRAGMENT_SHADER = /* glsl */ `
in vec4 v_color;
in vec4 v_pickColor;
in float v_pixelDistance;

void main() {
  float distanceToCenter = length(gl_PointCoord - vec2(0.5));
  vec4 color = v_color;
  color.a *= 1.0 - smoothstep(max(0.0, 0.5 - v_pixelDistance), 0.5, distanceToCenter);
  if (color.a < 0.005) discard;
  out_FragColor = czm_gammaCorrect(color);
}
`;

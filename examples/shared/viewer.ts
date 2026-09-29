import 'cesium/Build/Cesium/Widgets/widgets.css';

import {
  buildModuleUrl,
  ClockRange,
  ClockStep,
  ImageryLayer,
  Math as CesiumMath,
  type OrthographicOffCenterFrustum,
  type PerspectiveFrustum,
  type Scene,
  SceneMode,
  ScreenSpaceEventType,
  TileMapServiceImageryProvider,
  Viewer,
} from 'cesium';

declare global {
  interface Window {
    CESIUM_BASE_URL: string;
  }
}

// Where the build copied Cesium's static assets (see vite.config.ts).
window.CESIUM_BASE_URL = `${import.meta.env.BASE_URL}cesium/`;

/**
 * A viewer with no Cesium ion dependency: the Natural Earth II imagery shipped
 * with Cesium, no terrain, no geocoder. Cesium's own timeline and animation
 * widgets are off: the example draws its own.
 */
export const createViewer = (container: HTMLElement): Viewer => {
  const viewer = new Viewer(container, {
    baseLayer: ImageryLayer.fromProviderAsync(
      TileMapServiceImageryProvider.fromUrl(buildModuleUrl('Assets/Textures/NaturalEarthII')),
    ),
    animation: false,
    timeline: false,
    baseLayerPicker: false,
    geocoder: false,
    homeButton: false,
    sceneModePicker: false,
    navigationHelpButton: false,
    fullscreenButton: false,
    infoBox: false,
    selectionIndicator: false,
    // Frames are drawn only when something changes (the clock included): a
    // paused globe costs nothing.
    requestRenderMode: true,
  });

  // The whole globe lit by default; `setLighting` turns the day/night terminator on.
  viewer.scene.globe.enableLighting = false;

  // Double-click would track an entity; this scene has none.
  viewer.screenSpaceEventHandler.removeInputAction(ScreenSpaceEventType.LEFT_DOUBLE_CLICK);

  keepMorphsSeamless(viewer.scene);

  const { clock } = viewer;
  clock.clockRange = ClockRange.UNBOUNDED;
  clock.clockStep = ClockStep.SYSTEM_CLOCK;
  clock.multiplier = 1;
  clock.shouldAnimate = true;
  return viewer;
};

/** Shows the day/night terminator, which follows the clock, or lights the whole globe. */
export const setLighting = (viewer: Viewer, isLit: boolean): void => {
  viewer.scene.globe.enableLighting = isLit;
  viewer.scene.requestRender();
};

/**
 * Removes the jump at the 2D end of an animated morph between 3D and 2D.
 *
 * Cesium hands over between its perspective view and the 2D orthographic one
 * with extents that do not match. Measured on Cesium 1.145, with `k = 2
 * tan(fov / 2)`, about 1.15 for the default 60° field of view:
 *
 * - as a morph to 2D completes, the map scales by `k` times the canvas aspect
 *   ratio, capped at 1: a 15% zoom in on a landscape canvas;
 * - as a morph from 2D starts, it scales by `1 / k` on a landscape canvas, and
 *   not at all on a portrait one.
 *
 * The 2D frustum is rescaled by the same amounts, so both hand-overs are seamless.
 */
const keepMorphsSeamless = (scene: Scene): void => {
  let fov = CesiumMath.PI_OVER_THREE;
  const k = () => 2 * Math.tan(fov / 2);
  const aspect = () => scene.drawingBufferWidth / scene.drawingBufferHeight;
  const scale2D = (factor: number) => {
    const frustum = scene.camera.frustum as OrthographicOffCenterFrustum;
    frustum.left = frustum.left! * factor;
    frustum.right = frustum.right! * factor;
    frustum.top = frustum.top! * factor;
    frustum.bottom = frustum.bottom! * factor;
  };

  scene.morphStart.addEventListener((_: unknown, from: SceneMode, to: SceneMode) => {
    if (from === SceneMode.SCENE3D) fov = (scene.camera.frustum as PerspectiveFrustum).fov ?? fov;
    if (from === SceneMode.SCENE2D && to === SceneMode.SCENE3D && aspect() >= 1) scale2D(1 / k());
  });
  scene.morphComplete.addEventListener(
    (_: unknown, from: SceneMode, to: SceneMode, wasMorphing: boolean) => {
      if (wasMorphing && from === SceneMode.SCENE3D && to === SceneMode.SCENE2D) {
        scale2D(k() * Math.min(1, aspect()));
      }
    },
  );
};

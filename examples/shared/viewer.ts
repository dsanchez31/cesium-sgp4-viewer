import 'cesium/Build/Cesium/Widgets/widgets.css';

import {
  buildModuleUrl,
  ClockRange,
  ClockStep,
  ImageryLayer,
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
  // Frame rate overlay hidden by default; `setFramesPerSecond` shows it.
  viewer.scene.debugShowFramesPerSecond = false;

  // Double-click would track an entity; this scene has none.
  viewer.screenSpaceEventHandler.removeInputAction(ScreenSpaceEventType.LEFT_DOUBLE_CLICK);

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

/** Shows or hides Cesium's frame rate overlay. */
export const setFramesPerSecond = (viewer: Viewer, isShown: boolean): void => {
  viewer.scene.debugShowFramesPerSecond = isShown;
  viewer.scene.requestRender();
};

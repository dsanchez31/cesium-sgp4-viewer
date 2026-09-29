// cesium-sgp4-viewer in Sandcastle.
//
// Paste this file into the JavaScript panel of https://sandcastle.cesium.com.
// The library's IIFE build reads Cesium from the page's global `Cesium`, so it
// uses the very instance Sandcastle already loaded.

const LIBRARY_VERSION = 'latest';
const LIBRARY_URL = `https://cdn.jsdelivr.net/npm/@dsanchez31/cesium-sgp4-viewer@${LIBRARY_VERSION}/dist/cesium-sgp4-viewer.iife.js`;
const TLE_URL =
  'https://cdn.jsdelivr.net/gh/dsanchez31/cesium-sgp4-viewer@main/examples/data/tle.txt';

const loadScript = (src) =>
  new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.onload = resolve;
    script.onerror = () => reject(new Error(`Could not load ${src}`));
    document.head.append(script);
  });

const viewer = new Cesium.Viewer('cesiumContainer', {
  animation: true,
  timeline: true,
  baseLayerPicker: false,
  geocoder: false,
  infoBox: false,
  selectionIndicator: false,
});
viewer.clock.clockStep = Cesium.ClockStep.SYSTEM_CLOCK_MULTIPLIER;
viewer.clock.multiplier = 60;
viewer.clock.shouldAnimate = true;
viewer.scene.debugShowFramesPerSecond = true;

(async () => {
  await loadScript(LIBRARY_URL);
  const { parseTleCatalog, SatelliteLayer, enableInertialCamera } = window.CesiumSgp4Viewer;

  const text = await (await fetch(TLE_URL)).text();
  const { satellites } = parseTleCatalog(text);
  const layer = new SatelliteLayer(viewer, { satellites, labels: 'hover' });
  enableInertialCamera(viewer.scene);

  // Search by name or NORAD ID.
  const search = document.createElement('input');
  search.type = 'search';
  search.placeholder = 'Name or NORAD ID';
  search.addEventListener('input', () => {
    const query = search.value.trim().toLowerCase();
    layer.setFilter(
      query === ''
        ? null
        : (s) => s.noradId.startsWith(query) || s.name.toLowerCase().includes(query),
    );
  });
  document.getElementById('toolbar').append(search);

  Sandcastle.addToggleButton('Orbits', false, (checked) => {
    layer.orbits = checked;
  });
  Sandcastle.addToolbarMenu([
    { text: 'All regimes', onselect: () => layer.setRegimes(null) },
    { text: 'LEO', onselect: () => layer.setRegimes(['LEO']) },
    { text: 'MEO', onselect: () => layer.setRegimes(['MEO']) },
    { text: 'GEO', onselect: () => layer.setRegimes(['GEO']) },
    { text: 'HEO', onselect: () => layer.setRegimes(['HEO']) },
  ]);
  Sandcastle.addToolbarMenu([
    { text: 'Labels on hover', onselect: () => (layer.labels = 'hover') },
    { text: 'All labels', onselect: () => (layer.labels = 'all') },
    { text: 'No labels', onselect: () => (layer.labels = 'none') },
  ]);
  Sandcastle.addToolbarButton('3D', () => viewer.scene.morphTo3D(0.8));
  Sandcastle.addToolbarButton('2D', () => viewer.scene.morphTo2D(0.8));

  layer.on('select', (satellite) => {
    if (satellite) {
      console.log(
        `${satellite.name} (${satellite.noradId}), ${satellite.regime}, ` +
          `period ${satellite.elements.periodMinutes.toFixed(1)} min`,
      );
    }
  });
})().catch((error) => console.error(error));

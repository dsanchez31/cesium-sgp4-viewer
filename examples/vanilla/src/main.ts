import '../../shared/style.css';

import {
  enableInertialCamera,
  type LabelMode,
  type OrbitRegime,
  parseTleCatalog,
  SatelliteLayer,
} from '@dsanchez31/cesium-sgp4-viewer';
import { Cartographic } from 'cesium';

import { onClockTick, readClock, scrubTo } from '../../shared/clock';
import { searchPredicate } from '../../shared/format';
import { createViewer, setFramesPerSecond, setLighting } from '../../shared/viewer';
import { mountDetails } from './ui/details';
import { byId } from './ui/dom';
import { mountRegimes } from './ui/regimes';
import { mountTimeline } from './ui/timeline';
import { mountTransport } from './ui/transport';

const viewer = createViewer(byId('globe', HTMLDivElement));
// The Earth turns under a camera fixed in space, as seen from orbit.
enableInertialCamera(viewer.scene);

/** What the controls hold, reapplied to every new layer (a loaded file replaces it). */
const settings = {
  orbits: false,
  labels: 'hover' as LabelMode,
  regimes: null as OrbitRegime[] | null,
  query: '',
};

let layer: SatelliteLayer | undefined;
let rejectedCount = 0;

const stats = byId('stats', HTMLOutputElement);
const renderStats = () => {
  if (!layer) return;
  const parts = [
    `${layer.visibleCount.toLocaleString('en-US')} / ${layer.satellites.length.toLocaleString('en-US')} satellites`,
  ];
  if (rejectedCount > 0) parts.push(`${rejectedCount} TLE rejected`);
  stats.textContent = parts.join(' · ');
};

const details = mountDetails(byId('details', HTMLElement), () => layer?.select(null));

const load = (text: string) => {
  layer?.destroy();
  const catalog = parseTleCatalog(text);
  rejectedCount = catalog.rejected.length;
  if (rejectedCount > 0) console.warn('Rejected TLEs', catalog.rejected);

  layer = new SatelliteLayer(viewer, {
    satellites: catalog.satellites,
    orbits: settings.orbits,
    labels: settings.labels,
  });
  layer.setRegimes(settings.regimes);
  layer.setFilter(searchPredicate(settings.query));
  layer.on('select', (satellite) => details.show(satellite));
  layer.on('update', ({ failed }) => {
    renderStats();
    if (failed > 0) stats.textContent += ` · ${failed} not propagable`;
  });
  layer.on('error', (error) => {
    stats.textContent = `Propagation failed: ${error.message}`;
  });
  details.show(null);
  renderStats();
};

// Search by name or NORAD ID.
byId('search', HTMLInputElement).addEventListener('input', (event) => {
  settings.query = (event.target as HTMLInputElement).value;
  layer?.setFilter(searchPredicate(settings.query));
  renderStats();
});

mountRegimes(byId('regimes', HTMLFieldSetElement), (regimes) => {
  settings.regimes = regimes.length === 4 ? null : regimes;
  layer?.setRegimes(settings.regimes);
  renderStats();
});

// 3D / 2D.
const mode3d = byId('mode-3d', HTMLButtonElement);
const mode2d = byId('mode-2d', HTMLButtonElement);
const setMode = (is3d: boolean) => {
  if (is3d) viewer.scene.morphTo3D(0.8);
  else viewer.scene.morphTo2D(0.8);
  mode3d.setAttribute('aria-pressed', String(is3d));
  mode2d.setAttribute('aria-pressed', String(!is3d));
};
mode3d.addEventListener('click', () => setMode(true));
mode2d.addEventListener('click', () => setMode(false));

const orbits = byId('orbits', HTMLButtonElement);
orbits.addEventListener('click', () => {
  settings.orbits = !settings.orbits;
  orbits.setAttribute('aria-pressed', String(settings.orbits));
  if (layer) layer.orbits = settings.orbits;
});

const lighting = byId('lighting', HTMLButtonElement);
lighting.addEventListener('click', () => {
  const isLit = lighting.getAttribute('aria-pressed') !== 'true';
  setLighting(viewer, isLit);
  lighting.setAttribute('aria-pressed', String(isLit));
});

const fps = byId('fps', HTMLButtonElement);
fps.addEventListener('click', () => {
  const isShown = fps.getAttribute('aria-pressed') !== 'true';
  setFramesPerSecond(viewer, isShown);
  fps.setAttribute('aria-pressed', String(isShown));
});

byId('labels', HTMLSelectElement).addEventListener('change', (event) => {
  settings.labels = (event.target as HTMLSelectElement).value as LabelMode;
  if (layer) layer.labels = settings.labels;
});

byId('file', HTMLInputElement).addEventListener('change', (event) => {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (file) void file.text().then(load);
});

// Transport, timeline and the selected satellite's altitude follow the clock.
const transport = mountTransport(viewer, () => readClock(viewer));
const timeline = mountTimeline(byId('timeline', HTMLDivElement), (ms) => {
  scrubTo(viewer, ms);
  refresh();
});
const scratch = new Cartographic();
const refresh = () => {
  const state = readClock(viewer);
  transport.render();
  timeline.render(state.ms);
  const selected = layer?.selected;
  if (selected) {
    const position = layer?.positionOf(selected.noradId);
    details.setAltitude(
      position ? Cartographic.fromCartesian(position, undefined, scratch).height : undefined,
    );
  }
};
onClockTick(viewer, refresh);
refresh();

fetch(`${import.meta.env.BASE_URL}tle.txt`)
  .then((response) => {
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.text();
  })
  .then(load)
  .catch((error: unknown) => {
    stats.textContent = `Could not load tle.txt: ${String(error)}`;
  });

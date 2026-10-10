import '../../shared/style.css';
import './style.css';

import {
  DEFAULT_REGIME_COLORS,
  ORBIT_REGIMES,
  type Satellite,
} from '@dsanchez31/cesium-sgp4-viewer';
import {
  Cartesian2,
  Cartesian3,
  Color,
  DistanceDisplayCondition,
  JulianDate,
  NearFarScalar,
} from 'cesium';

import { regimeCode } from '../../../src/orbit/regime.js';
import { OrbitPrimitive } from '../../../src/render/OrbitPrimitive.js';
import { PointLayer } from '../../../src/render/PointLayer.js';
import { createViewer } from '../../shared/viewer';
import { BufferOrbitLayer } from './buffer/BufferOrbitLayer.js';
import { BufferPointLayer } from './buffer/BufferPointLayer.js';
import { getBufferApi } from './buffer/cesiumBufferApi.js';
import { FrameRecorder, type RunResult } from './metrics';
import { SyntheticCatalog } from './syntheticOrbits';

type PointsImpl = 'legacy' | 'buffer';
type OrbitsImpl = 'off' | 'legacy' | 'buffer';

interface RunConfig {
  count: number;
  points: PointsImpl;
  orbits: OrbitsImpl;
}

const WARM_UP_MS = 3_000;
const MEASURE_MS = 10_000;
const COUNTS = [16_000, 50_000, 100_000, 250_000];
const DRAW_ORDER = (['LEO', 'MEO', 'HEO', 'GEO'] as const).map(regimeCode);
const ORBIT_OPACITY = 0.35;
const POINT_SIZE = 3;

const byId = <T extends HTMLElement>(id: string, type: new () => T): T => {
  const element = document.getElementById(id);
  if (!(element instanceof type)) throw new Error(`#${id} is not a ${type.name}`);
  return element;
};

const viewer = createViewer(byId('globe', HTMLDivElement));
const { scene } = viewer;
// Every frame drawn, whatever changes: the frame rate is what is measured.
scene.requestRenderMode = false;
// The whole catalog in view, from the same place on every run.
viewer.camera.setView({ destination: Cartesian3.fromDegrees(10, 20, 6e7) });

const api = getBufferApi();
const regimeColors = ORBIT_REGIMES.map((regime) =>
  Color.fromCssColorString(DEFAULT_REGIME_COLORS[regime]),
);
const orbitColors = regimeColors.map((color) => color.withAlpha(ORBIT_OPACITY));

const recorder = new FrameRecorder();
const results: RunResult[] = [];
const catalogs = new Map<number, SyntheticCatalog>();

/** What one run put in the scene, and how to update and remove it. */
interface Scenario {
  update: (ms: number, time: JulianDate) => void;
  destroy: () => void;
}

let current: Scenario | undefined;

const catalogOf = (count: number): SyntheticCatalog => {
  let catalog = catalogs.get(count);
  if (!catalog) {
    catalog = new SyntheticCatalog(count, Date.now());
    catalogs.set(count, catalog);
  }
  return catalog;
};

const createPoints = (impl: PointsImpl, catalog: SyntheticCatalog): Scenario => {
  if (impl === 'buffer') {
    if (!api) throw new Error('This CesiumJS build has no BufferPointCollection.setPositions');
    const layer = new BufferPointLayer(scene, api, catalog.count, {
      pixelSize: POINT_SIZE,
      colorOf: (i) => regimeColors[catalog.regimes[i]!]!,
    });
    return {
      update: (ms) => layer.update(ms, catalog, () => true),
      destroy: () => layer.destroy(),
    };
  }

  // `PointLayer` reads only the regime of a satellite outside label modes.
  const satellites = Array.from(
    catalog.regimes,
    (code, i) =>
      ({
        name: String(i),
        noradId: String(i),
        regime: ORBIT_REGIMES[code],
      }) as unknown as Satellite,
  );
  // The library's own point style, distance scaling included.
  const layer = new PointLayer(
    scene,
    satellites,
    catalog,
    {
      pixelSize: POINT_SIZE,
      colorOf: (satellite) => regimeColors[regimeCode(satellite.regime)]!,
      scaleByDistance: new NearFarScalar(2e6, 1.4, 8e7, 0.8),
      translucencyByDistance: new NearFarScalar(1.5e7, 1, 1.5e8, 0.6),
    },
    {
      font: '12px sans-serif',
      fillColor: Color.WHITE,
      outlineColor: Color.BLACK,
      outlineWidth: 3,
      pixelOffset: new Cartesian2(0, -10),
      distanceDisplayCondition: new DistanceDisplayCondition(0, 2.5e7),
    },
  );
  return { update: (ms) => layer.update(ms), destroy: () => layer.destroy() };
};

const createOrbits = (impl: OrbitsImpl, catalog: SyntheticCatalog): Scenario => {
  if (impl === 'off') return { update: () => undefined, destroy: () => undefined };
  const batches = [{ rings: catalog.rings(), start: 0, groups: catalog.regimes }];

  if (impl === 'buffer') {
    if (!api) throw new Error('This CesiumJS build has no BufferPolylineCollection.setPositions');
    const layer = new BufferOrbitLayer(scene, api, orbitColors, DRAW_ORDER);
    layer.setBatches(batches);
    return { update: (_, time) => layer.update(time), destroy: () => layer.destroy() };
  }

  const primitive = scene.primitives.add(new OrbitPrimitive(orbitColors, DRAW_ORDER));
  primitive.setBatches(batches, catalog.epochMs);
  primitive.setVisibility(null);
  return { update: () => undefined, destroy: () => scene.primitives.remove(primitive) };
};

/** Replaces the scene's content with `config`'s. Orbits first: points draw over them. */
const build = (config: RunConfig): void => {
  current?.destroy();
  const catalog = catalogOf(config.count);
  const orbits = createOrbits(config.orbits, catalog);
  const points = createPoints(config.points, catalog);
  current = {
    update: (ms, time) => {
      orbits.update(ms, time);
      points.update(ms, time);
    },
    destroy: () => {
      points.destroy();
      orbits.destroy();
    },
  };
};

scene.preUpdate.addEventListener((_, time: JulianDate) => {
  if (!current) return;
  const scenario = current;
  recorder.timeUpdate(() => scenario.update(JulianDate.toDate(time).getTime(), time));
});
scene.postRender.addEventListener(() => recorder.rendered());

const status = byId('status', HTMLOutputElement);
const tbody = byId('results', HTMLTableElement).tBodies[0]!;
const controls = ['count', 'points', 'orbits', 'run', 'matrix'].map((id) => byId(id, HTMLElement));

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const format = (value: number) => (Number.isFinite(value) ? value.toFixed(2) : '–');

const appendRow = (result: RunResult): void => {
  const row = tbody.insertRow();
  for (const text of [
    result.count.toLocaleString('en-US'),
    result.points,
    result.orbits,
    `${format(result.updateMs.mean)} / ${format(result.updateMs.p95)}`,
    `${format(result.frameCpuMs.mean)} / ${format(result.frameCpuMs.p95)}`,
    result.fps.toFixed(1),
    result.heapMb === null ? '–' : result.heapMb.toFixed(0),
  ]) {
    row.insertCell().textContent = text;
  }
};

const run = async (config: RunConfig): Promise<void> => {
  const label = `${config.count.toLocaleString('en-US')} · points ${config.points} · orbits ${config.orbits}`;
  status.textContent = `Building ${label}…`;
  // Let the status paint before a build that may block for a while.
  await wait(50);
  build(config);
  status.textContent = `Warming up ${label}…`;
  await wait(WARM_UP_MS);
  status.textContent = `Measuring ${label}…`;
  recorder.start();
  await wait(MEASURE_MS);
  const result = recorder.stop(config);
  results.push(result);
  appendRow(result);
  status.textContent = `Done: ${label}`;
};

const exclusive = async (work: () => Promise<void>): Promise<void> => {
  for (const control of controls) control.toggleAttribute('disabled', true);
  try {
    await work();
  } catch (error) {
    status.textContent = String(error);
    console.error(error);
  } finally {
    for (const control of controls) control.toggleAttribute('disabled', false);
  }
};

const selected = (): RunConfig => ({
  count: Number(byId('count', HTMLSelectElement).value),
  points: byId('points', HTMLSelectElement).value as PointsImpl,
  orbits: byId('orbits', HTMLSelectElement).value as OrbitsImpl,
});

byId('run', HTMLButtonElement).addEventListener(
  'click',
  () => void exclusive(() => run(selected())),
);

byId('matrix', HTMLButtonElement).addEventListener(
  'click',
  () =>
    void exclusive(async () => {
      for (const count of COUNTS) {
        for (const orbits of ['off', 'legacy', 'buffer'] as const) {
          for (const points of ['legacy', 'buffer'] as const) await run({ count, points, orbits });
        }
      }
    }),
);

byId('copy', HTMLButtonElement).addEventListener('click', () => {
  const report = {
    userAgent: navigator.userAgent,
    devicePixelRatio: window.devicePixelRatio,
    canvas: [scene.canvas.width, scene.canvas.height],
    results,
  };
  void navigator.clipboard.writeText(JSON.stringify(report, null, 2)).then(
    () => (status.textContent = 'Results copied'),
    () => console.log(report),
  );
});

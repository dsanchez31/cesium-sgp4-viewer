import {
  Cartesian2,
  Cartesian3,
  type Clock,
  Color,
  DistanceDisplayCondition,
  JulianDate,
  NearFarScalar,
  type Scene,
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
} from 'cesium';

import { Emitter } from './events.js';
import { ORBIT_REGIMES, type OrbitRegime, regimeCode } from './orbit/regime.js';
import { OrbitPrimitive } from './render/OrbitPrimitive.js';
import { type LabelMode, PointLayer } from './render/PointLayer.js';
import { SelectionMarker } from './render/SelectionMarker.js';
import { TrackStore } from './render/TrackStore.js';
import { ringSegments } from './sampling/grid.js';
import {
  ringsNeedRebuild,
  SamplingWindow,
  type SamplingWindowOptions,
} from './time/SamplingWindow.js';
import type { Satellite } from './tle/parseCatalog.js';
import { PropagationPool, type ShardRings } from './worker/pool.js';
import { buildRings } from './worker/rings.js';

/** A colour as a Cesium `Color` or any CSS colour string. */
export type ColorLike = Color | string;

/** The default palette, one hue per regime. */
export const DEFAULT_REGIME_COLORS: Readonly<Record<OrbitRegime, string>> = {
  LEO: '#4fc3f7',
  MEO: '#b388ff',
  GEO: '#ffb74d',
  HEO: '#f06292',
};

export interface SatelliteLayerOptions {
  /** The catalog, typically from `parseTleCatalog`. Fixed for the layer's lifetime. */
  satellites: readonly Satellite[];
  /** Draw every orbit (rings in 3D, ground tracks in 2D). Default: `false`. */
  orbits?: boolean;
  /** Satellite names. Default: `'hover'`. */
  labels?: LabelMode;
  /** Colour per regime, for points and orbits. Missing entries use {@link DEFAULT_REGIME_COLORS}. */
  colors?: Partial<Record<OrbitRegime, ColorLike>>;
  /** Opacity of the catalog's orbits, 0 to 1. Default: `0.35`. */
  orbitOpacity?: number;
  /** Point diameter in pixels. Default: `3`. */
  pointSize?: number;
  /** Colour of the selected satellite's orbit. Default: near white. */
  selectedOrbitColor?: ColorLike;
  /** Colour of the ring around the selected satellite. Default: lime. */
  selectionColor?: ColorLike;
  /** CSS font of the labels. Default: `'12px sans-serif'`. */
  labelFont?: string;
  /** Number of propagation workers. Default: CPU cores minus one, at most 4. */
  workers?: number;
  /** Span propagated around the playhead. */
  window?: SamplingWindowOptions;
}

export interface PropagationStatus {
  /** Satellites with a position over the current window. */
  propagated: number;
  /** Satellites SGP4 could not propagate over the window (decayed orbits, mostly). */
  failed: number;
  windowStart: Date;
  windowStop: Date;
}

export interface SatelliteLayerEvents {
  /** The selection changed, by a click or by {@link SatelliteLayer.select}. */
  select: Satellite | null;
  /** New samples arrived from the workers. */
  update: PropagationStatus;
  /** Propagation failed. The layer retries a few seconds later. */
  error: Error;
}

/** The regimes' orbits are drawn from the lowest shell up, so a higher shell's front arc lands on top. */
const DRAW_ORDER = (['LEO', 'MEO', 'HEO', 'GEO'] as const).map(regimeCode);

const RETRY_DELAY_MS = 5_000;

const toColor = (color: ColorLike): Color =>
  typeof color === 'string' ? Color.fromCssColorString(color) : color;

/**
 * A catalog of satellites on a Cesium scene: points at their SGP4 positions,
 * orbits, names, filters and selection, following the scene's clock.
 *
 * Propagation runs in web workers over a window of time around the playhead,
 * and the main thread only interpolates, so the frame rate holds with tens of
 * thousands of objects.
 *
 * @example
 * const { satellites } = parseTleCatalog(await (await fetch('/tle.txt')).text());
 * const layer = new SatelliteLayer(viewer, { satellites, orbits: true });
 * layer.on('select', (satellite) => console.log(satellite?.name));
 */
export class SatelliteLayer {
  readonly satellites: readonly Satellite[];
  /** Settles with the first propagation, or rejects if the layer is destroyed before it. */
  readonly ready: Promise<void>;

  private readonly scene: Scene;
  private readonly clock: Clock;
  private readonly events = new Emitter<SatelliteLayerEvents>();
  private readonly pool: PropagationPool;
  private readonly tracks: TrackStore;
  private readonly points: PointLayer;
  private readonly orbitPrimitive: OrbitPrimitive;
  private readonly selectedOrbit: OrbitPrimitive;
  private readonly marker: SelectionMarker;
  private readonly handler: ScreenSpaceEventHandler;
  private readonly removePreUpdate: () => void;
  private readonly windowOptions: SamplingWindowOptions;
  private readonly indexById = new Map<string, number>();
  private readonly regimeCodes: Uint8Array;

  private settleReady: ((error?: Error) => void) | undefined;
  private window: SamplingWindow | null = null;
  private samplesInFlight = false;
  private ringsInFlight = false;
  private retryAt = 0;
  private ringEpochMs: number | null = null;
  private selectedRingEpochMs: number | null = null;
  private showOrbits: boolean;
  private labelMode: LabelMode;
  private regimes: ReadonlySet<OrbitRegime> | null = null;
  private filter: ((satellite: Satellite) => boolean) | null = null;
  private readonly visible: Uint8Array;
  private visibleTotal: number;
  private selectedIndex: number | undefined;
  private readonly hoverPosition = new Cartesian2();
  private hoverFrame = 0;
  /** Whether the layer set the canvas cursor, so it only ever resets its own. */
  private pointer = false;
  private destroyed = false;

  constructor(viewer: { scene: Scene; clock: Clock }, options: SatelliteLayerOptions) {
    this.scene = viewer.scene;
    this.clock = viewer.clock;
    this.satellites = options.satellites;
    this.windowOptions = options.window ?? {};
    this.showOrbits = options.orbits ?? false;
    this.labelMode = options.labels ?? 'hover';

    const { satellites } = this;
    satellites.forEach((satellite, i) => {
      if (!this.indexById.has(satellite.noradId)) this.indexById.set(satellite.noradId, i);
    });
    this.regimeCodes = Uint8Array.from(satellites, (satellite) => regimeCode(satellite.regime));
    this.visible = new Uint8Array(satellites.length).fill(1);
    this.visibleTotal = satellites.length;

    const regimeColors = ORBIT_REGIMES.map((regime) =>
      toColor(options.colors?.[regime] ?? DEFAULT_REGIME_COLORS[regime]),
    );
    const orbitOpacity = options.orbitOpacity ?? 0.35;

    this.pool = new PropagationPool(satellites, options.workers);
    this.tracks = new TrackStore(this.pool.shards, satellites.length);

    // Added to the scene in drawing order: catalog orbits, selected orbit,
    // points (translucent pass, so over every line), then the marker.
    this.orbitPrimitive = this.scene.primitives.add(
      new OrbitPrimitive(
        regimeColors.map((color) => color.withAlpha(orbitOpacity)),
        DRAW_ORDER,
      ),
    ) as OrbitPrimitive;
    this.orbitPrimitive.show = this.showOrbits;
    this.selectedOrbit = this.scene.primitives.add(
      new OrbitPrimitive([toColor(options.selectedOrbitColor ?? '#f8fafc')], [0]),
    ) as OrbitPrimitive;

    this.points = new PointLayer(
      this.scene,
      satellites,
      this.tracks,
      {
        pixelSize: options.pointSize ?? 3,
        colorOf: (satellite) => regimeColors[regimeCode(satellite.regime)]!,
        scaleByDistance: new NearFarScalar(2e6, 1.4, 8e7, 0.8),
        translucencyByDistance: new NearFarScalar(1.5e7, 1, 1.5e8, 0.6),
      },
      {
        font: options.labelFont ?? '12px sans-serif',
        fillColor: Color.fromCssColorString('#f1f5f9'),
        outlineColor: Color.fromCssColorString('#0b1220'),
        outlineWidth: 3,
        pixelOffset: new Cartesian2(0, -10),
        distanceDisplayCondition: new DistanceDisplayCondition(0, 2.5e7),
        scaleByDistance: new NearFarScalar(1e6, 1, 4e7, 0.6),
      },
    );
    this.points.setLabelMode(this.labelMode);

    this.marker = new SelectionMarker(this.scene, {
      color: toColor(options.selectionColor ?? '#bef264'),
      sizePixels: 18,
    });

    this.ready = new Promise<void>((resolve, reject) => {
      this.settleReady = (error) => {
        if (error) reject(error);
        else resolve();
      };
    });
    // Callers may ignore `ready`; a failure is also reported through `error`.
    this.ready.catch(() => undefined);

    // `LEFT_CLICK` only fires when the button goes up where it went down, so a
    // camera drag never changes the selection.
    this.handler = new ScreenSpaceEventHandler(this.scene.canvas);
    this.handler.setInputAction((click: ScreenSpaceEventHandler.PositionedEvent) => {
      this.setSelectedIndex(this.points.pick(click.position));
    }, ScreenSpaceEventType.LEFT_CLICK);
    this.handler.setInputAction((move: ScreenSpaceEventHandler.MotionEvent) => {
      Cartesian2.clone(move.endPosition, this.hoverPosition);
      // At most one pick per animation frame, however fast the mouse moves.
      if (this.hoverFrame === 0) this.hoverFrame = requestAnimationFrame(this.onHover);
    }, ScreenSpaceEventType.MOUSE_MOVE);

    this.removePreUpdate = this.scene.preUpdate.addEventListener(this.onPreUpdate);
    this.scene.requestRender();
  }

  /** Whether every orbit is drawn. The selected satellite's orbit is drawn regardless. */
  get orbits(): boolean {
    return this.showOrbits;
  }

  set orbits(show: boolean) {
    this.showOrbits = show;
    this.orbitPrimitive.show = show;
    this.scene.requestRender();
  }

  get labels(): LabelMode {
    return this.labelMode;
  }

  set labels(mode: LabelMode) {
    this.labelMode = mode;
    this.points.setLabelMode(mode);
  }

  /** How many satellites pass the current regime and custom filters. */
  get visibleCount(): number {
    return this.visibleTotal;
  }

  get selected(): Satellite | null {
    return this.selectedIndex === undefined ? null : this.satellites[this.selectedIndex]!;
  }

  /** Shows only these regimes, or all of them with `null`. */
  setRegimes(regimes: Iterable<OrbitRegime> | null): void {
    this.regimes = regimes === null ? null : new Set(regimes);
    this.applyFilters();
  }

  /**
   * Shows only the satellites the predicate accepts, or all of them with
   * `null`. Combined with {@link setRegimes}. Cheap: nothing is propagated
   * again, so it can run on every keystroke of a search box.
   *
   * @example
   * layer.setFilter((s) => s.name.includes('STARLINK') || s.noradId === '25544');
   */
  setFilter(predicate: ((satellite: Satellite) => boolean) | null): void {
    this.filter = predicate;
    this.applyFilters();
  }

  /** Selects a satellite by catalog number, or clears the selection with `null`. */
  select(noradId: string | null): void {
    this.setSelectedIndex(noradId === null ? undefined : this.indexById.get(noradId));
  }

  find(noradId: string): Satellite | undefined {
    const i = this.indexById.get(noradId);
    return i === undefined ? undefined : this.satellites[i];
  }

  /**
   * Earth-fixed position of a satellite as currently drawn, if it is: a copy,
   * in `result` when given.
   */
  positionOf(noradId: string, result?: Cartesian3): Cartesian3 | undefined {
    const i = this.indexById.get(noradId);
    const position = i === undefined ? undefined : this.points.drawnPosition(i);
    return position && Cartesian3.clone(position, result);
  }

  on<K extends keyof SatelliteLayerEvents>(
    event: K,
    listener: (value: SatelliteLayerEvents[K]) => void,
  ): () => void {
    return this.events.on(event, listener);
  }

  /** Removes everything from the scene and stops the workers. */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.removePreUpdate();
    if (this.hoverFrame !== 0) cancelAnimationFrame(this.hoverFrame);
    if (this.pointer) this.scene.canvas.style.cursor = '';
    this.settleReady?.(new Error('the layer was destroyed before its first propagation'));
    this.settleReady = undefined;
    this.handler.destroy();
    this.pool.destroy();
    this.points.destroy();
    this.marker.destroy();
    this.scene.primitives.remove(this.orbitPrimitive);
    this.scene.primitives.remove(this.selectedOrbit);
    this.events.clear();
    this.scene.requestRender();
  }

  private readonly onPreUpdate = (_: Scene, time: JulianDate): void => {
    const ms = JulianDate.toDate(time).getTime();
    this.requestSamples(ms);
    this.points.update(ms);
    this.syncSelectedOrbit(ms);
    const selected = this.selectedIndex;
    this.marker.update(
      selected === undefined ? undefined : this.points.drawnPosition(selected),
      this.clock.shouldAnimate,
    );
  };

  private readonly onHover = (): void => {
    this.hoverFrame = 0;
    if (this.destroyed) return;
    const i = this.points.pick(this.hoverPosition);
    const pointer = i !== undefined;
    if (pointer !== this.pointer) {
      this.pointer = pointer;
      this.scene.canvas.style.cursor = pointer ? 'pointer' : '';
    }
    if (this.labelMode === 'hover') this.points.setHovered(i);
  };

  /**
   * Moves the sampled window and rebuilds the rings when needed, one request of
   * each kind at a time. They are separate requests so that the points, which
   * matter most, never wait for the rings, which cost several times more.
   */
  private requestSamples(ms: number): void {
    if (performance.now() < this.retryAt) return;
    if (!this.samplesInFlight && (this.window === null || this.window.needsMove(ms))) {
      this.moveWindow(ms);
    }
    if (!this.ringsInFlight && this.showOrbits && ringsNeedRebuild(this.ringEpochMs, ms)) {
      this.rebuildRings(ms);
    }
  }

  private moveWindow(ms: number): void {
    const window = SamplingWindow.around(ms, this.windowOptions);
    this.samplesInFlight = true;
    this.pool.sample(window.startMs, window.stopMs).then(
      (results) => {
        if (this.destroyed) return;
        this.samplesInFlight = false;
        this.window = window;
        this.tracks.update(results);
        this.points.invalidate();

        const failed = this.tracks.failedCount();
        this.events.emit('update', {
          propagated: this.satellites.length - failed,
          failed,
          windowStart: new Date(window.startMs),
          windowStop: new Date(window.stopMs),
        });
        this.settleReady?.();
        this.settleReady = undefined;
      },
      (reason: unknown) => {
        if (this.destroyed) return;
        this.samplesInFlight = false;
        this.fail(reason);
      },
    );
  }

  private rebuildRings(epochMs: number): void {
    this.ringsInFlight = true;
    this.pool.rings(epochMs).then(
      (results) => {
        if (this.destroyed) return;
        this.ringsInFlight = false;
        this.setRings(results, epochMs);
      },
      (reason: unknown) => {
        if (this.destroyed) return;
        this.ringsInFlight = false;
        this.fail(reason);
      },
    );
  }

  private fail(reason: unknown): void {
    this.retryAt = performance.now() + RETRY_DELAY_MS;
    const error = reason instanceof Error ? reason : new Error(String(reason));
    this.events.emit('error', error);
    this.settleReady?.(error);
    this.settleReady = undefined;
  }

  private setRings(results: readonly ShardRings[], epochMs: number): void {
    const batches = results.map(({ rings, shard }) => ({
      rings,
      start: shard.start,
      groups: this.regimeCodes.subarray(shard.start, shard.start + shard.size),
    }));
    this.ringEpochMs = epochMs;
    this.orbitPrimitive.setBatches(batches, epochMs);
    this.orbitPrimitive.setVisibility(this.filtersActive() ? this.visible : null);
    this.scene.requestRender();
  }

  /**
   * The selected orbit shares the catalog rings' epoch while those are drawn,
   * so it lies exactly on its own ring; otherwise it is rebuilt hourly.
   */
  private syncSelectedOrbit(ms: number): void {
    const i = this.selectedIndex;
    if (i === undefined) return;

    let epochMs = this.selectedRingEpochMs;
    if (this.showOrbits && this.ringEpochMs !== null) epochMs = this.ringEpochMs;
    else if (ringsNeedRebuild(epochMs, ms)) epochMs = ms;
    if (epochMs === this.selectedRingEpochMs || epochMs === null) return;

    const { satrec, elements } = this.satellites[i]!;
    const rings = buildRings(
      [{ satrec, periodSeconds: elements.periodMinutes * 60, segments: ringSegments(satrec.ecco) }],
      epochMs,
    );
    this.selectedOrbit.setBatches([{ rings, start: 0, groups: new Uint8Array(1) }], epochMs);
    this.selectedOrbit.setVisibility(null);
    this.selectedRingEpochMs = epochMs;
  }

  private setSelectedIndex(i: number | undefined): void {
    const next = i !== undefined && this.visible[i] !== 0 ? i : undefined;
    if (next === this.selectedIndex) return;
    this.selectedIndex = next;
    this.selectedRingEpochMs = null;
    if (next === undefined) this.selectedOrbit.setBatches([], 0);
    this.scene.requestRender();
    this.events.emit('select', this.selected);
  }

  private filtersActive(): boolean {
    return this.regimes !== null || this.filter !== null;
  }

  private applyFilters(): void {
    const { satellites, visible, regimes, filter } = this;
    let total = 0;
    for (let i = 0; i < satellites.length; i++) {
      const satellite = satellites[i]!;
      const shown = (!regimes || regimes.has(satellite.regime)) && (!filter || filter(satellite));
      visible[i] = shown ? 1 : 0;
      if (shown) total++;
    }
    this.visibleTotal = total;

    const mask = this.filtersActive() ? visible : null;
    this.points.setVisibility(mask);
    this.orbitPrimitive.setVisibility(mask);
    if (this.selectedIndex !== undefined && visible[this.selectedIndex] === 0) {
      this.setSelectedIndex(undefined);
    }
    this.scene.requestRender();
  }
}

/** Mean and 95th percentile of a series, in its unit. */
export interface Summary {
  mean: number;
  p95: number;
}

const summarize = (values: readonly number[]): Summary => {
  if (values.length === 0) return { mean: Number.NaN, p95: Number.NaN };
  const sorted = [...values].sort((a, b) => a - b);
  const mean = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
  return { mean, p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]! };
};

export interface RunResult {
  count: number;
  points: string;
  orbits: string;
  frames: number;
  /** Main-thread time of the layers' per-frame update, ms. */
  updateMs: Summary;
  /** Main-thread time from `preUpdate` to `postRender`: update plus Cesium's own work, ms. */
  frameCpuMs: Summary;
  /** Time between two `postRender`, ms. Capped by the display refresh rate. */
  frameIntervalMs: Summary;
  fps: number;
  /** `performance.memory.usedJSHeapSize` (Chromium only), MB. */
  heapMb: number | null;
}

/**
 * Collects per-frame timings between `start` and `stop`. Only the main thread
 * is measured: WebGL gives no portable GPU timer.
 */
export class FrameRecorder {
  private recording = false;
  private frameStart = Number.NaN;
  private lastRender = Number.NaN;
  private readonly update: number[] = [];
  private readonly frameCpu: number[] = [];
  private readonly interval: number[] = [];

  start(): void {
    this.update.length = 0;
    this.frameCpu.length = 0;
    this.interval.length = 0;
    this.lastRender = Number.NaN;
    this.recording = true;
  }

  /** Times `work`, the layers' update for this frame. Call from `scene.preUpdate`. */
  timeUpdate(work: () => void): void {
    const before = performance.now();
    work();
    const after = performance.now();
    this.frameStart = before;
    if (this.recording) this.update.push(after - before);
  }

  /** Call from `scene.postRender`. */
  rendered(): void {
    const now = performance.now();
    if (!this.recording) return;
    if (!Number.isNaN(this.frameStart)) this.frameCpu.push(now - this.frameStart);
    if (!Number.isNaN(this.lastRender)) this.interval.push(now - this.lastRender);
    this.lastRender = now;
  }

  stop(config: Pick<RunResult, 'count' | 'points' | 'orbits'>): RunResult {
    this.recording = false;
    const frameIntervalMs = summarize(this.interval);
    const memory = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
    return {
      ...config,
      frames: this.interval.length,
      updateMs: summarize(this.update),
      frameCpuMs: summarize(this.frameCpu),
      frameIntervalMs,
      fps: 1_000 / frameIntervalMs.mean,
      heapMb: memory ? memory.usedJSHeapSize / 1_048_576 : null,
    };
  }
}

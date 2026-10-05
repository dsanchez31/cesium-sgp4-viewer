import PropagationWorker from './propagation.worker?worker&inline';
import type { FromWorker, RingBuffers, RingsResult, SampleResult, ToWorker } from './protocol.js';

/** A contiguous slice of the catalog, owned by one worker. */
export interface Shard {
  /** Index of the shard's first satellite in the catalog. */
  start: number;
  size: number;
}

export interface ShardResult extends SampleResult {
  shard: Shard;
}

export interface ShardRings {
  rings: RingBuffers;
  shard: Shard;
}

type Answer = SampleResult | RingsResult;

interface Pending {
  resolve: (answer: Answer) => void;
  reject: (error: Error) => void;
}

/** Leave a core to the main thread, and stop at four: beyond that the gain is small. */
export const defaultPoolSize = (): number => {
  const cores = (globalThis.navigator as Navigator | undefined)?.hardwareConcurrency;
  return Math.min(Math.max((cores ?? 4) - 1, 1), 4);
};

/**
 * A few workers, each holding one shard of the catalog for its lifetime.
 *
 * SGP4 is pure arithmetic per satellite, so the shards need no coordination:
 * a request goes to every worker and the answers are gathered.
 */
export class PropagationPool {
  readonly shards: readonly Shard[];
  private readonly workers: Worker[];
  private readonly pending = new Map<number, Pending>();
  private nextRequestId = 0;
  private destroyed = false;

  constructor(tles: readonly { line1: string; line2: string }[], size = defaultPoolSize()) {
    const count = Math.max(1, Math.min(size, tles.length));
    const shardSize = Math.ceil(tles.length / count);
    const shards: Shard[] = [];
    this.workers = [];

    for (let s = 0; s < count; s++) {
      const start = s * shardSize;
      const slice = tles.slice(start, start + shardSize);
      shards.push({ start, size: slice.length });

      const worker = new PropagationWorker({ name: `sgp4-propagation-${s}` });
      worker.onmessage = (event: MessageEvent<FromWorker>) => this.settle(event.data);
      worker.onerror = (event) => this.failAll(new Error(`propagation worker: ${event.message}`));
      const message: ToWorker = { type: 'load', tles: slice.flatMap((t) => [t.line1, t.line2]) };
      worker.postMessage(message);
      this.workers.push(worker);
    }

    this.shards = shards;
  }

  /** Samples every shard over the window. */
  async sample(startMs: number, stopMs: number): Promise<ShardResult[]> {
    const results = await this.broadcast<SampleResult>((requestId) => ({
      type: 'sample',
      requestId,
      startMs,
      stopMs,
    }));
    return results.map((result, s) => ({ ...result, shard: this.shards[s]! }));
  }

  /**
   * Rebuilds every shard's rings around `epochMs`. A worker answers in order:
   * a window move requested before this one is not held up by it.
   */
  async rings(epochMs: number): Promise<ShardRings[]> {
    const results = await this.broadcast<RingsResult>((requestId) => ({
      type: 'rings',
      requestId,
      epochMs,
    }));
    return results.map(({ rings }, s) => ({ rings, shard: this.shards[s]! }));
  }

  destroy(): void {
    this.destroyed = true;
    for (const worker of this.workers) worker.terminate();
    this.failAll(new Error('the propagation pool was destroyed'));
  }

  /** Sends a request to every worker; each answers with the type the request asks for. */
  private broadcast<A extends Answer>(message: (requestId: number) => ToWorker): Promise<A[]> {
    if (this.destroyed) return Promise.reject(new Error('the propagation pool was destroyed'));
    return Promise.all(
      this.workers.map(
        (worker) =>
          new Promise<A>((resolve, reject) => {
            const requestId = this.nextRequestId++;
            this.pending.set(requestId, { resolve: resolve as (answer: Answer) => void, reject });
            worker.postMessage(message(requestId));
          }),
      ),
    );
  }

  private settle(message: FromWorker): void {
    if (message.type !== 'error') {
      this.pending.get(message.requestId)?.resolve(message);
      this.pending.delete(message.requestId);
      return;
    }

    const error = new Error(`propagation worker: ${message.message}`);
    // A failure outside any request (loading the catalog) leaves every request without an answer.
    if (message.requestId === null) {
      this.failAll(error);
      return;
    }
    this.pending.get(message.requestId)?.reject(error);
    this.pending.delete(message.requestId);
  }

  private failAll(error: Error): void {
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
  }
}

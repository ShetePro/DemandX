/**
 * Client-side politeness: at most `rps` requests per second per host, plus a
 * jittered gap so a burst never looks like a bot. Futures quotas (T3.5) are a
 * separate concern; this limiter only slows us down, it never rejects.
 */
const DEFAULT_RPS = 1;
/** The build plan's 3–8s jitter, wide enough that parallel angles desync. */
const DEFAULT_MIN_DELAY_MS = 3_000;
const DEFAULT_MAX_DELAY_MS = 8_000;

export interface RateLimiterOptions {
  /** Requests per second floor, per host. */
  rps?: number;
  minDelayMs?: number;
  maxDelayMs?: number;
  /** Injected clock hooks so tests never wait in real time. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
}

export interface RateLimiter {
  /** Resolves once `host` may be requested again. */
  acquire(host: string): Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export function createRateLimiter(options: RateLimiterOptions = {}): RateLimiter {
  const rps = options.rps ?? DEFAULT_RPS;
  if (!Number.isFinite(rps) || rps <= 0) {
    throw new RangeError('rps must be a positive number');
  }

  const minDelayMs = Math.max(0, options.minDelayMs ?? DEFAULT_MIN_DELAY_MS);
  const maxDelayMs = Math.max(minDelayMs, options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS);
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;

  /** Last request time per host, and the in-flight chain that owns it. */
  const lastHitAt = new Map<string, number>();
  const queues = new Map<string, Promise<void>>();

  /** `max(1/rps, jitter)`: the floor wins when rps is the stricter bound. */
  const intervalMs = (): number =>
    Math.max(1_000 / rps, minDelayMs + random() * (maxDelayMs - minDelayMs));

  async function waitForSlot(host: string): Promise<void> {
    const last = lastHitAt.get(host);
    if (last !== undefined) {
      const wait = last + intervalMs() - now();
      if (wait > 0) await sleep(wait);
    }
    lastHitAt.set(host, now());
  }

  return {
    acquire(host: string): Promise<void> {
      // Serialise per host so concurrent callers cannot both observe the same
      // stale timestamp and fire together.
      const previous = queues.get(host) ?? Promise.resolve();
      const next = previous.then(() => waitForSlot(host));
      queues.set(
        host,
        next.catch(() => undefined),
      );
      return next;
    },
  };
}

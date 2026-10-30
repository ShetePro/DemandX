import { sql } from '@/lib/db/client';

import { QUOTA_WINDOWS, windowStart, type QuotaPolicy, type QuotaWindow } from './policy';
import { fail, ok, type Result } from './types';

/** Counter returned by a successful claim; `limit` is `Infinity` for unmanaged sources. */
export interface ClaimedQuota {
  used: number;
  limit: number;
}

/**
 * The storage half of the guard, injectable so tests (and future workers) can
 * swap it. `claim` must be atomic: it either reserves one request and returns
 * the resulting count, or returns `null` because the window is already full.
 */
export interface QuotaRepo {
  claim(source: string, window: QuotaWindow, start: Date, limit: number): Promise<number | null>;
}

export interface QuotaGuard {
  /** Reserve one request for `source`; a budget failure is returned, not thrown. */
  claim(source: string): Promise<Result<ClaimedQuota>>;
}

export interface QuotaGuardOptions {
  policy: QuotaPolicy;
  /** Injectable clock; tests pin it, production reads the wall clock. */
  now?: () => Date;
  /** Defaults to Postgres (`source_usage`). */
  repo?: QuotaRepo;
}

/**
 * Counts one request and refuses it at the same time, in a single statement.
 * `ON CONFLICT ... WHERE` makes the check and the increment indivisible, so
 * concurrent claims can never push `requests` past `limit`: the conflicting
 * update re-reads the locked row and skips the increment once it is full.
 * Policy limits must be >= 1 here; the guard short-circuits `limit === 0`.
 */
export const databaseQuotaRepo: QuotaRepo = {
  async claim(source, window, start, limit) {
    // Bound as an ISO string, not a Date: drizzle installs pass-through
    // serializers for timestamptz, so postgres.js cannot encode a Date here.
    const rows = await sql<{ requests: number }[]>`
      insert into source_usage as su (source, "window", window_start, requests)
      values (${source}, ${window}, ${start.toISOString()}, 1)
      on conflict (source, "window", window_start) do update
        set requests = su.requests + 1
        where su.requests < ${limit}
      returning requests
    `;
    return rows[0]?.requests ?? null;
  },
};

/** SQLSTATE only: postgres.js errors also carry query text and parameters. */
function storageFailure<T>(action: string, error: unknown): Result<T> {
  const state = (error as { code?: unknown } | null)?.code;
  const detail = typeof state === 'string' ? ` (SQLSTATE ${state})` : '';
  return fail('STORAGE_FAILED', `${action}失败${detail}`);
}

function quotaExceeded(source: string, window: QuotaWindow, limit: number): Result<ClaimedQuota> {
  return fail('QUOTA_EXCEEDED', `来源 ${source} 的 ${window} 配额已用尽（上限 ${limit}）`);
}

/** A bad policy is a programming error, so it throws instead of degrading. */
function assertPolicy(policy: QuotaPolicy): void {
  for (const [source, rule] of Object.entries(policy)) {
    if (!QUOTA_WINDOWS.includes(rule.window)) {
      throw new RangeError(`来源 ${source} 的窗口 ${rule.window} 不受支持`);
    }
    if (!Number.isInteger(rule.limit) || rule.limit < 0) {
      throw new RangeError(`来源 ${source} 的配额上限必须是 >= 0 的整数`);
    }
  }
}

export function createQuotaGuard(options: QuotaGuardOptions): QuotaGuard {
  const { policy } = options;
  const now = options.now ?? (() => new Date());
  const repo = options.repo ?? databaseQuotaRepo;

  assertPolicy(policy);

  return {
    async claim(source: string): Promise<Result<ClaimedQuota>> {
      const rule = policy[source];
      // A source without a rule is not metered at all.
      if (rule === undefined) return ok({ used: 0, limit: Number.POSITIVE_INFINITY });
      if (rule.limit === 0) return quotaExceeded(source, rule.window, rule.limit);

      // A bad clock is a programming error, not a degraded run.
      const start = windowStart(rule.window, now());

      try {
        const used = await repo.claim(source, rule.window, start, rule.limit);
        // `null` means the row was already at the limit; no increment happened.
        if (used === null) return quotaExceeded(source, rule.window, rule.limit);
        return ok({ used, limit: rule.limit });
      } catch (error) {
        return storageFailure(`记录 ${source} 配额`, error);
      }
    },
  };
}

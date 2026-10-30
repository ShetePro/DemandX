import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { QuotaPolicy } from './policy';
import type { Result } from './types';
// Type-only namespace imports are erased; the runtime modules are imported
// dynamically below because the db client reads DATABASE_URL at load time.
import type * as ClientModule from '@/lib/db/client';
import type * as GuardModule from './guard';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL?.trim() ?? '';

/** Database name from a postgres URL, or '' when it cannot be parsed. */
function databaseName(url: string): string {
  try {
    return new URL(url).pathname.replace(/^\//, '');
  } catch {
    return '';
  }
}

// Integration tests TRUNCATE tables. Refuse to run against anything that is not
// an explicitly named `*_test` database, even if a bad URL is passed in.
if (TEST_DATABASE_URL && !databaseName(TEST_DATABASE_URL).endsWith('_test')) {
  throw new Error(
    `拒绝在非 _test 数据库上运行集成测试：${
      databaseName(TEST_DATABASE_URL) || '(无法解析数据库名)'
    }。TEST_DATABASE_URL 的库名必须以 _test 结尾。`,
  );
}

const suite = TEST_DATABASE_URL ? describe : describe.skip;

const MINUTE = new Date('2026-10-30T12:00:00.000Z');

const POLICY: QuotaPolicy = {
  github: { window: 'minute', limit: 2 },
  hn: { window: 'minute', limit: 5 },
};

let guardModule!: typeof GuardModule;
let client!: typeof ClientModule;

const previousDatabaseUrl = process.env.DATABASE_URL;

suite('quota guard', () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    guardModule = await import('./guard');
    client = await import('@/lib/db/client');
  });

  afterAll(async () => {
    await client.closeDb();

    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
  });

  beforeEach(async () => {
    await client.sql.unsafe('TRUNCATE source_usage');
  });

  function unwrap<T>(result: Result<T>): T {
    if (!result.ok) throw new Error(`expected ok, got ${result.code}: ${result.message}`);
    return result.value;
  }

  function expectFailure<T>(result: Result<T>): Extract<Result<T>, { ok: false }> {
    if (result.ok) throw new Error('expected a failure result, got ok');
    return result;
  }

  it('allows exactly `limit` claims in a window, then refuses without counting the refusal', async () => {
    const guard = guardModule.createQuotaGuard({ policy: POLICY, now: () => MINUTE });

    expect(unwrap(await guard.claim('github'))).toEqual({ used: 1, limit: 2 });
    expect(unwrap(await guard.claim('github'))).toEqual({ used: 2, limit: 2 });

    const failure = expectFailure(await guard.claim('github'));
    expect(failure.code).toBe('QUOTA_EXCEEDED');
    expect(failure.message).toContain('github');

    const rows = await client.sql<{ requests: number }[]>`
      select requests from source_usage where source = 'github'
    `;
    expect(rows).toEqual([{ requests: 2 }]);
  });

  it('meters each source independently', async () => {
    const guard = guardModule.createQuotaGuard({ policy: POLICY, now: () => MINUTE });

    unwrap(await guard.claim('github'));
    unwrap(await guard.claim('github'));
    expect(expectFailure(await guard.claim('github')).code).toBe('QUOTA_EXCEEDED');

    // `hn` has its own counter and its own budget, untouched by github.
    expect(unwrap(await guard.claim('hn'))).toEqual({ used: 1, limit: 5 });

    const rows = await client.sql<{ source: string; requests: number }[]>`
      select source, requests from source_usage order by source
    `;
    expect(rows).toEqual([
      { source: 'github', requests: 2 },
      { source: 'hn', requests: 1 },
    ]);
  });

  it('starts from zero when the clock rolls into a new window', async () => {
    let now = MINUTE;
    const guard = guardModule.createQuotaGuard({ policy: POLICY, now: () => now });

    unwrap(await guard.claim('github'));
    unwrap(await guard.claim('github'));
    expect(expectFailure(await guard.claim('github')).code).toBe('QUOTA_EXCEEDED');

    // Still the same minute: the budget stays exhausted.
    now = new Date('2026-10-30T12:00:59.999Z');
    expect(expectFailure(await guard.claim('github')).code).toBe('QUOTA_EXCEEDED');

    // Next minute: a new window row, so the counter restarts at one.
    now = new Date('2026-10-30T12:01:00.000Z');
    expect(unwrap(await guard.claim('github'))).toEqual({ used: 1, limit: 2 });

    const rows = await client.sql<{ window_start: string; requests: number }[]>`
      select window_start, requests from source_usage where source = 'github' order by window_start
    `;
    expect(rows.map((row) => [new Date(row.window_start).toISOString(), row.requests])).toEqual([
      ['2026-10-30T12:00:00.000Z', 2],
      ['2026-10-30T12:01:00.000Z', 1],
    ]);
  });

  it('does not meter a source without a policy', async () => {
    const guard = guardModule.createQuotaGuard({ policy: POLICY, now: () => MINUTE });

    expect(unwrap(await guard.claim('exa'))).toEqual({ used: 0, limit: Number.POSITIVE_INFINITY });

    const rows = await client.sql<{ count: number }[]>`
      select count(*)::int as count from source_usage
    `;
    expect(rows[0]?.count).toBe(0);
  });

  it('refuses a zero-limit source without touching the database', async () => {
    const guard = guardModule.createQuotaGuard({
      policy: { bing: { window: 'minute', limit: 0 } },
      now: () => MINUTE,
    });

    expect(expectFailure(await guard.claim('bing')).code).toBe('QUOTA_EXCEEDED');

    const rows = await client.sql<{ count: number }[]>`
      select count(*)::int as count from source_usage
    `;
    expect(rows[0]?.count).toBe(0);
  });

  it('never over-issues under concurrency', async () => {
    const guard = guardModule.createQuotaGuard({
      policy: { github: { window: 'minute', limit: 3 } },
      now: () => MINUTE,
    });

    const results = await Promise.all(Array.from({ length: 10 }, () => guard.claim('github')));

    const succeeded = results.flatMap((result) => (result.ok ? [result.value.used] : []));
    const refused = results.flatMap((result) => (result.ok ? [] : [result.code]));

    expect(succeeded.sort((a, b) => a - b)).toEqual([1, 2, 3]);
    expect(refused).toEqual(Array.from({ length: 7 }, () => 'QUOTA_EXCEEDED'));

    const rows = await client.sql<{ requests: number }[]>`
      select requests from source_usage where source = 'github'
    `;
    expect(rows).toEqual([{ requests: 3 }]);
  });

  it('returns STORAGE_FAILED when the repo throws instead of throwing itself', async () => {
    const guard = guardModule.createQuotaGuard({
      policy: POLICY,
      now: () => MINUTE,
      repo: {
        claim: () => Promise.reject(Object.assign(new Error('boom'), { code: '08006' })),
      },
    });

    const failure = expectFailure(await guard.claim('github'));
    expect(failure.code).toBe('STORAGE_FAILED');
    expect(failure.message).toContain('08006');
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type * as ClientModule from '@/lib/db/client';
// Type-only imports are erased; the runtime modules are imported dynamically
// below because the db client reads DATABASE_URL at load time.
import type * as StoreModule from './store';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL?.trim() ?? '';

function databaseName(url: string): string {
  try {
    return new URL(url).pathname.replace(/^\//, '');
  } catch {
    return '';
  }
}

// Same guard as the other integration suites: these tests TRUNCATE.
if (TEST_DATABASE_URL && !databaseName(TEST_DATABASE_URL).endsWith('_test')) {
  throw new Error(
    `拒绝在非 _test 数据库上运行集成测试：${
      databaseName(TEST_DATABASE_URL) || '(无法解析数据库名)'
    }。TEST_DATABASE_URL 的库名必须以 _test 结尾。`,
  );
}

const suite = TEST_DATABASE_URL ? describe : describe.skip;

let store!: typeof StoreModule;
let client!: typeof ClientModule;

const previousDatabaseUrl = process.env.DATABASE_URL;

suite('settings store', () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    store = await import('./store');
    client = await import('@/lib/db/client');
  });

  afterAll(async () => {
    await client.closeDb();

    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
  });

  beforeEach(async () => {
    await client.sql.unsafe('TRUNCATE settings');
  });

  it('falls back to the documented crawl defaults', () => {
    expect(store.DEFAULT_CRAWL_SETTINGS).toEqual({
      enabled: true,
      respectRobots: true,
      perHostConcurrency: 1,
      minDelayMs: 3000,
      maxDelayMs: 8000,
      maxPagesPerRun: 120,
      deadlineMinutes: 90,
    });
    // A partial object is filled in rather than rejected.
    expect(store.crawlSettingsSchema.parse({ maxPagesPerRun: 40 })).toMatchObject({
      maxPagesPerRun: 40,
      minDelayMs: 3000,
    });
  });

  it('rejects out-of-range values and an inverted delay window', () => {
    expect(store.crawlSettingsSchema.safeParse({ perHostConcurrency: 9 }).success).toBe(false);
    expect(store.crawlSettingsSchema.safeParse({ minDelayMs: 500 }).success).toBe(false);
    expect(
      store.crawlSettingsSchema.safeParse({ minDelayMs: 9000, maxDelayMs: 5000 }).success,
    ).toBe(false);
  });

  it('returns null before anything is saved, then round-trips the value', async () => {
    expect(await store.getSetting('crawl', store.crawlSettingsSchema)).toEqual({
      ok: true,
      value: null,
    });

    const value = store.crawlSettingsSchema.parse({
      minDelayMs: 4000,
      maxDelayMs: 9000,
      maxPagesPerRun: 30,
      deadlineMinutes: 30,
    });
    const saved = await store.setSetting('crawl', value);
    expect(saved.ok).toBe(true);

    expect(await store.getSetting('crawl', store.crawlSettingsSchema)).toEqual({
      ok: true,
      value,
    });

    // Saving again upserts the same key instead of failing on the primary key.
    const updated = { ...value, maxPagesPerRun: 60 };
    expect((await store.setSetting('crawl', updated)).ok).toBe(true);
    expect(await store.getSetting('crawl', store.crawlSettingsSchema)).toEqual({
      ok: true,
      value: updated,
    });
  });

  it('reports a stored value that no longer matches the schema', async () => {
    await client.sql`
      insert into settings (key, value) values ('crawl', ${JSON.stringify({
        perHostConcurrency: 9,
      })}::jsonb)
    `;

    const result = await store.getSetting('crawl', store.crawlSettingsSchema);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('VALIDATION_FAILED');
    expect(result.message).toContain('perHostConcurrency');
  });

  it('draws a delay inside the configured window', () => {
    const settings = { ...store.DEFAULT_CRAWL_SETTINGS, minDelayMs: 1000, maxDelayMs: 3000 };
    expect(store.pickDelayMs(settings, () => 0)).toBe(1000);
    expect(store.pickDelayMs(settings, () => 0.999999)).toBe(3000);
  });
});

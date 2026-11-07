import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type * as ClientModule from '@/lib/db/client';
import type * as MemoryModule from './memory';
import type { DiscoveryValue } from './find';
import type { DiscoveryPlan } from './types';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL?.trim() ?? '';

function databaseName(url: string): string {
  try {
    return new URL(url).pathname.replace(/^\//, '');
  } catch {
    return '';
  }
}

if (TEST_DATABASE_URL && !databaseName(TEST_DATABASE_URL).endsWith('_test')) {
  throw new Error(
    `拒绝在非 _test 数据库上运行集成测试：${
      databaseName(TEST_DATABASE_URL) || '(无法解析数据库名)'
    }。TEST_DATABASE_URL 的库名必须以 _test 结尾。`,
  );
}

const suite = TEST_DATABASE_URL ? describe : describe.skip;

let memory!: typeof MemoryModule;
let client!: typeof ClientModule;

const previousDatabaseUrl = process.env.DATABASE_URL;

const PLAN: DiscoveryPlan = {
  angles: ['诊所排班', '门店库存'],
  queries: [
    { query: '诊所 排班 excel', angle: '诊所排班', language: 'zh' },
    { query: 'retail inventory spreadsheet', angle: '门店库存', language: 'en' },
  ],
  strategy: 'planned',
  rationale: '热点集中在排班与库存。',
};

const VALUE: DiscoveryValue = {
  sources: [
    { url: 'https://example.com/a', title: 'A', snippet: 'a', platform: 'hn' },
    { url: 'https://example.com/b', title: 'B', snippet: 'b', platform: 'web' },
  ],
  opportunities: [
    {
      title: '诊所排班助手',
      problem: '前台用 Excel 排班，换班全靠群里吼',
      audience: '牙科诊所',
      angle: '诊所排班',
      signal: 'problem',
      currentAlternative: 'Excel 排班表',
      competitors: [],
      monetization: 'subscription',
      mvp: '一周内上线排班与换班提醒',
      evidence: [{ url: 'https://example.com/a', quote: 'Excel 排班' }],
    },
  ],
  commercialGap: false,
  providers: ['hn'],
  elapsedMs: 1200,
  model: 'stub',
};

suite('discovery memory', () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    // Static imports cannot work here: the db client reads DATABASE_URL when it
    // first loads, so the modules must be imported after the env is pointed at
    // the test database (same pattern as the other *_repository suites).
    memory = await import('./memory');
    client = await import('@/lib/db/client');
  });

  afterAll(async () => {
    await client.closeDb();
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
  });

  beforeEach(async () => {
    await client.sql.unsafe(
      'TRUNCATE discovery_feedback, discovery_scans, threads, ideas RESTART IDENTITY CASCADE',
    );
  });

  it('round-trips a scan into the memory the next round reads', async () => {
    const stored = await memory.recordScan({
      plan: PLAN,
      queries: PLAN.queries.map((item) => item.query),
      result: VALUE,
      trendTitles: ['Ask HN: scheduling tools?'],
    });
    expect(stored.ok).toBe(true);
    if (!stored.ok) return;

    const loaded = await memory.loadScanMemory();
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;

    expect(loaded.value.scans).toHaveLength(1);
    expect(loaded.value.scans[0]?.angles).toEqual(['诊所排班', '门店库存']);
    expect(loaded.value.scans[0]?.queries).toEqual(['诊所 排班 excel', 'retail inventory spreadsheet']);
    expect(loaded.value.scans[0]?.opportunities[0]).toMatchObject({
      title: '诊所排班助手',
      angle: '诊所排班',
    });
    expect(loaded.value.excludedUrls).toEqual(['https://example.com/a', 'https://example.com/b']);
    expect(memory.priorFingerprints(loaded.value)).toHaveLength(1);
  });

  it('remembers adopted directions with their thread', async () => {
    const stored = await memory.recordScan({
      plan: PLAN,
      queries: PLAN.queries.map((item) => item.query),
      result: VALUE,
      trendTitles: [],
    });
    if (!stored.ok) throw new Error(stored.message);

    const [idea] = await client.sql<{ id: number }[]>`
      INSERT INTO ideas (title, raw_input) VALUES ('诊所排班', '牙科诊所排班') RETURNING id
    `;
    const [thread] = await client.sql<{ id: number }[]>`
      INSERT INTO threads (idea_id, title) VALUES (${idea?.id ?? 0}, '诊所排班') RETURNING id
    `;

    const feedback = await memory.recordFeedback({
      scanId: stored.value,
      opportunityTitle: '诊所排班助手',
      angle: '诊所排班',
      threadId: thread?.id ?? 0,
    });
    expect(feedback.ok).toBe(true);

    const loaded = await memory.loadScanMemory();
    if (!loaded.ok) throw new Error(loaded.message);
    expect(loaded.value.adopted).toEqual([{ title: '诊所排班助手', angle: '诊所排班' }]);
  });
});

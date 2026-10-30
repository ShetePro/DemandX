import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { Result } from '@/lib/quota/types';

// Type-only imports are erased; the runtime modules are imported dynamically
// below because the db client reads DATABASE_URL at load time.
import type * as ClientModule from '@/lib/db/client';
import type * as QueriesModule from './queries';

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

let queries!: typeof QueriesModule;
let client!: typeof ClientModule;

const previousDatabaseUrl = process.env.DATABASE_URL;

suite('evidence queries', () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    queries = await import('./queries');
    client = await import('@/lib/db/client');
  });

  afterAll(async () => {
    await client.closeDb();
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
  });

  beforeEach(async () => {
    await client.sql.unsafe(
      'TRUNCATE evidence, sources, queries, run_events, runs, threads, ideas RESTART IDENTITY CASCADE',
    );
  });

  function unwrap<T>(result: Result<T>): T {
    if (!result.ok) throw new Error(`expected ok, got ${result.code}: ${result.message}`);
    return result.value;
  }

  async function seedRun(): Promise<number> {
    const ideas = await client.sql<{ id: number }[]>`
      insert into ideas (title, raw_input) values ('想法', '想法') returning id
    `;
    const idea = ideas[0];
    if (!idea) throw new Error('idea insert returned no row');

    const runs = await client.sql<{ id: number }[]>`
      insert into runs (idea_id) values (${idea.id}) returning id
    `;
    const run = runs[0];
    if (!run) throw new Error('run insert returned no row');

    return run.id;
  }

  async function seedSource(runId: number, url: string, platform: string): Promise<number> {
    const rows = await client.sql<{ id: number }[]>`
      insert into sources (run_id, canonical_url, platform, content_hash)
      values (${runId}, ${url}, ${platform}, ${'a'.repeat(64)})
      returning id
    `;
    const row = rows[0];
    if (!row) throw new Error('source insert returned no row');
    return row.id;
  }

  interface SeedEvidence {
    runId: number;
    sourceId: number;
    quote: string;
    platform: string;
    signal: string;
    supports: string;
    doesNotProve: string;
    rejectedReason: string | null;
    createdAt: string;
    priceMentioned?: { amount: number; currency: string };
  }

  async function seedEvidence(row: SeedEvidence): Promise<void> {
    await client.sql`
      insert into evidence (
        run_id, source_id, quote, quote_offset, platform, signal, first_hand,
        supports, does_not_prove, rejected_reason, price_mentioned, created_at
      ) values (
        ${row.runId}, ${row.sourceId}, ${row.quote}, 0, ${row.platform}, ${row.signal}, true,
        ${row.supports}, ${row.doesNotProve}, ${row.rejectedReason},
        ${row.priceMentioned ? JSON.stringify(row.priceMentioned) : null}::jsonb, ${row.createdAt}
      )
    `;
  }

  let runId: number;
  let otherRunId: number;

  beforeEach(async () => {
    runId = await seedRun();
    otherRunId = await seedRun();

    const sourceA = await seedSource(runId, 'https://example.com/inventory', 'web');
    const sourceB = await seedSource(runId, 'https://example.com/pricing', 'reddit');
    const sourceOther = await seedSource(otherRunId, 'https://example.com/other', 'web');

    await seedEvidence({
      runId,
      sourceId: sourceA,
      quote: '我在三个平台之间手工同步库存',
      platform: 'web',
      signal: 'problem',
      supports: '作者描述自己的库存同步问题',
      doesNotProve: '不能证明这个问题有多普遍',
      rejectedReason: null,
      createdAt: '2026-10-01T00:00:00Z',
    });
    await seedEvidence({
      runId,
      sourceId: sourceB,
      quote: '我每个月为库存工具付 99 美元',
      platform: 'reddit',
      signal: 'paying',
      supports: '作者提到已经为同类工具付费',
      doesNotProve: '不能证明其他人也愿意付同样的价格',
      rejectedReason: null,
      createdAt: '2026-10-02T00:00:00Z',
      priceMentioned: { amount: 99, currency: 'USD' },
    });
    await seedEvidence({
      runId,
      sourceId: sourceB,
      quote: '多平台库存同步非常麻烦',
      platform: 'reddit',
      signal: 'problem',
      supports: '模型改写的抱怨',
      doesNotProve: '改写句不属于原文，不能作为引文',
      rejectedReason: 'quote_not_in_snapshot',
      createdAt: '2026-10-03T00:00:00Z',
    });
    await seedEvidence({
      runId: otherRunId,
      sourceId: sourceOther,
      quote: '另一个 run 的证据',
      platform: 'web',
      signal: 'seeking',
      supports: '隔离用',
      doesNotProve: '不属于当前 run',
      rejectedReason: null,
      createdAt: '2026-10-04T00:00:00Z',
    });
  });

  it('lists newest first with the joined canonical url and only this run', async () => {
    const rows = unwrap(await queries.listEvidence({ runId, limit: 200 }));

    expect(rows.map((row) => row.quote)).toEqual([
      '多平台库存同步非常麻烦',
      '我每个月为库存工具付 99 美元',
      '我在三个平台之间手工同步库存',
    ]);
    expect(rows.map((row) => row.sourceUrl)).toEqual([
      'https://example.com/pricing',
      'https://example.com/pricing',
      'https://example.com/inventory',
    ]);
    expect(rows[0]).toMatchObject({
      runId,
      signal: 'problem',
      firstHand: true,
      rejectedReason: 'quote_not_in_snapshot',
    });
    expect(rows[1]?.priceMentioned).toEqual({ amount: 99, currency: 'USD' });
  });

  it('filters by signal, platform, status and q', async () => {
    const paying = unwrap(await queries.listEvidence({ runId, filters: { signal: 'paying' } }));
    expect(paying.map((row) => row.id)).toHaveLength(1);
    expect(paying[0]?.quote).toBe('我每个月为库存工具付 99 美元');

    const reddit = unwrap(await queries.listEvidence({ runId, filters: { platform: 'reddit' } }));
    expect(reddit).toHaveLength(2);

    const accepted = unwrap(await queries.listEvidence({ runId, filters: { status: 'accepted' } }));
    expect(accepted).toHaveLength(2);
    expect(accepted.every((row) => row.rejectedReason === null)).toBe(true);

    const rejected = unwrap(await queries.listEvidence({ runId, filters: { status: 'rejected' } }));
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.quote).toBe('多平台库存同步非常麻烦');

    // `q` searches the quote and both claim fields.
    const byQuote = unwrap(await queries.listEvidence({ runId, filters: { q: '手工' } }));
    expect(byQuote.map((row) => row.quote)).toEqual(['我在三个平台之间手工同步库存']);

    const bySupports = unwrap(await queries.listEvidence({ runId, filters: { q: '同类工具' } }));
    expect(bySupports.map((row) => row.quote)).toEqual(['我每个月为库存工具付 99 美元']);

    const byUrl = unwrap(await queries.listEvidence({ runId, filters: { q: 'pricing' } }));
    expect(byUrl).toHaveLength(2);
  });

  it('caps the page at the requested limit', async () => {
    const rows = unwrap(await queries.listEvidence({ runId, limit: 1 }));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.quote).toBe('多平台库存同步非常麻烦');
  });

  it('partitions accepted and rejected counts', async () => {
    expect(unwrap(await queries.evidenceCounts(runId))).toEqual({ accepted: 2, rejected: 1 });
    expect(unwrap(await queries.evidenceCounts(otherRunId))).toEqual({ accepted: 1, rejected: 0 });
  });

  it('lists distinct platforms in a stable order', async () => {
    expect(unwrap(await queries.evidencePlatforms(runId))).toEqual(['reddit', 'web']);
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { Result } from '@/lib/quota/types';

import type * as AggregateModule from './aggregate';
import type * as ClientModule from '@/lib/db/client';
import type { Aggregate } from './types';

/**
 * `loadAggregate` is one SQL query over `evidence`; the counting rules live in
 * the pure module. This suite only proves the query selects the right rows —
 * accepted, this run, price preserved — so it skips without a test database.
 */
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

let aggregateModule!: typeof AggregateModule;
let client!: typeof ClientModule;

const previousDatabaseUrl = process.env.DATABASE_URL;

suite('loadAggregate', () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    aggregateModule = await import('./aggregate');
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

  function unwrap(result: Result<Aggregate>): Aggregate {
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

  async function seedSource(runId: number, url: string): Promise<number> {
    const rows = await client.sql<{ id: number }[]>`
      insert into sources (run_id, canonical_url, platform, content_hash)
      values (${runId}, ${url}, ${'a'.repeat(64)}, 'web')
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
    signal: 'problem' | 'seeking' | 'paying' | 'switching' | 'recurring';
    rejectedReason?: string | null;
    priceMentioned?: unknown;
  }

  async function seedEvidence(row: SeedEvidence): Promise<void> {
    await client.sql`
      insert into evidence (
        run_id, source_id, quote, quote_offset, platform, signal, first_hand,
        supports, does_not_prove, rejected_reason, price_mentioned
      ) values (
        ${row.runId}, ${row.sourceId}, ${row.quote}, 0, 'web', ${row.signal}, true,
        '支持', '不证明', ${row.rejectedReason ?? null},
        ${
          row.priceMentioned === undefined
            ? null
            : client.sql`${JSON.stringify(row.priceMentioned)}::jsonb`
        }
      )
    `;
  }

  it('reads accepted evidence of one run only', async () => {
    const runId = await seedRun();
    const otherRunId = await seedRun();
    const sourceA = await seedSource(runId, 'https://example.com/a');
    const sourceB = await seedSource(runId, 'https://example.com/b');
    const sourceOther = await seedSource(otherRunId, 'https://example.com/other');

    await seedEvidence({
      runId,
      sourceId: sourceA,
      quote: '我每个月为这个工作流付 99 美元',
      signal: 'paying',
      priceMentioned: { amount: 99, currency: 'USD' },
    });
    await seedEvidence({
      runId,
      sourceId: sourceB,
      quote: '我已经用了两年，还会继续付费',
      signal: 'recurring',
    });
    await seedEvidence({
      runId,
      sourceId: sourceB,
      quote: '我在三个平台之间手工同步库存',
      signal: 'problem',
      rejectedReason: 'quote_not_in_snapshot',
    });
    await seedEvidence({
      runId: otherRunId,
      sourceId: sourceOther,
      quote: '另一个 run 的付费证据',
      signal: 'paying',
      priceMentioned: { amount: 5, currency: 'USD' },
    });

    const aggregate = unwrap(await aggregateModule.loadAggregate(runId));

    expect(aggregate).toEqual({
      n: 2,
      p: 1,
      c: 0,
      comp: 0,
      r: 1,
      hasVerifiablePrice: true,
      known: { competitors: false, complaints: false },
    });
  });

  it('treats a malformed price payload as no verifiable price', async () => {
    const runId = await seedRun();
    const sourceId = await seedSource(runId, 'https://example.com/pricing');

    await seedEvidence({
      runId,
      sourceId,
      quote: '每月九十九',
      signal: 'paying',
      priceMentioned: { amount: '99', currency: 'USD' },
    });

    const aggregate = unwrap(await aggregateModule.loadAggregate(runId));

    expect(aggregate.p).toBe(1);
    expect(aggregate.hasVerifiablePrice).toBe(false);
  });

  it('returns zeros for a run with no evidence', async () => {
    const runId = await seedRun();

    expect(unwrap(await aggregateModule.loadAggregate(runId))).toEqual({
      n: 0,
      p: 0,
      c: 0,
      comp: 0,
      r: 0,
      hasVerifiablePrice: false,
      known: { competitors: false, complaints: false },
    });
  });
});

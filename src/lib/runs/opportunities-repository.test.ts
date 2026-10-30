import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { Result } from '@/lib/quota/types';

// Type-only namespace imports are erased; the runtime modules are imported
// dynamically below because the db client reads DATABASE_URL at load time.
import type * as ClientModule from '@/lib/db/client';
import type * as EvidenceModule from './evidence-repository';
import type * as OpportunitiesModule from './opportunities-repository';

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

let repo!: typeof OpportunitiesModule;
let evidenceRepo!: typeof EvidenceModule;
let client!: typeof ClientModule;

const previousDatabaseUrl = process.env.DATABASE_URL;

suite('opportunities repository', () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    // Static imports cannot work here: the db client reads DATABASE_URL when the
    // module first loads, which is why these suites import it after the env is set.
    repo = await import('./opportunities-repository');
    evidenceRepo = await import('./evidence-repository');
    client = await import('@/lib/db/client');
  });

  afterAll(async () => {
    await client.closeDb();

    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
  });

  beforeEach(async () => {
    await client.sql.unsafe(
      'TRUNCATE opportunities, scores, evidence, sources, queries, run_events, runs, threads, ideas RESTART IDENTITY CASCADE',
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

  async function seedSource(runId: number, canonicalUrl: string, hash: string): Promise<number> {
    const rows = await client.sql<{ id: number }[]>`
      insert into sources (run_id, canonical_url, platform, content_hash, snapshot_path)
      values (${runId}, ${canonicalUrl}, 'v2ex', ${hash.repeat(64).slice(0, 64)}, '/tmp/snapshots/aa/a.txt.gz')
      returning id
    `;
    const row = rows[0];
    if (!row) throw new Error('source insert returned no row');
    return row.id;
  }

  const EVIDENCE: Omit<EvidenceModule.InsertEvidenceInput, 'runId' | 'sourceId'> = {
    quote: '我在三个平台之间手工同步库存',
    quoteOffset: 0,
    platform: 'v2ex',
    publishedAt: null,
    signal: 'problem',
    firstHand: true,
    priceMentioned: null,
    supports: '作者在描述自己的库存同步问题',
    doesNotProve: '不能证明这个问题有多普遍',
    rejectedReason: null,
  };

  it('stores an opportunity and reads back its evidence ids in order', async () => {
    const runId = await seedRun();
    const otherRunId = await seedRun();

    const inserted = unwrap(
      await repo.insertOpportunity({
        runId,
        name: '库存同步',
        positioning: '面向多平台卖家的库存同步工具',
        independentSources: 3,
        evidenceIds: [9, 3, 7],
      }),
    );

    unwrap(
      await repo.insertOpportunity({
        runId: otherRunId,
        name: '别的机会',
        positioning: '另一个机会',
        independentSources: 4,
        evidenceIds: [1],
      }),
    );

    // The array column must round-trip exactly: S4 addresses evidence by id, so
    // a reordered or stringified array would make every score uncitable.
    expect(unwrap(await repo.listOpportunities(runId))).toEqual([
      {
        id: inserted.id,
        runId,
        name: '库存同步',
        positioning: '面向多平台卖家的库存同步工具',
        independentSources: 3,
        evidenceIds: [9, 3, 7],
      },
    ]);
  });

  it('lists opportunities of one run oldest first and nothing for a run without any', async () => {
    const runId = await seedRun();
    const emptyRunId = await seedRun();
    const otherRunId = await seedRun();

    const first = unwrap(
      await repo.insertOpportunity({
        runId,
        name: '第一个',
        positioning: '先被创建的机会',
        independentSources: 3,
        evidenceIds: [1, 2, 3],
      }),
    );
    const second = unwrap(
      await repo.insertOpportunity({
        runId,
        name: '第二个',
        positioning: '后被创建的机会',
        independentSources: 4,
        evidenceIds: [4, 5, 6, 7],
      }),
    );
    unwrap(
      await repo.insertOpportunity({
        runId: otherRunId,
        name: '别的 run',
        positioning: '不属于本次运行',
        independentSources: 3,
        evidenceIds: [8, 9, 10],
      }),
    );

    expect(unwrap(await repo.listOpportunities(runId)).map((row) => row.id)).toEqual([
      first.id,
      second.id,
    ]);
    expect(unwrap(await repo.listOpportunities(emptyRunId))).toEqual([]);
  });

  it('lists accepted evidence joined to its page and never a rejected row', async () => {
    const runId = await seedRun();
    const otherRunId = await seedRun();

    const alpha = await seedSource(runId, 'https://example.com/alpha', 'a');
    const beta = await seedSource(runId, 'https://example.com/beta', 'b');
    const other = await seedSource(otherRunId, 'https://example.com/other', 'c');

    const acceptedFirst = unwrap(
      await evidenceRepo.insertEvidence({ ...EVIDENCE, runId, sourceId: alpha }),
    );
    const acceptedSecond = unwrap(
      await evidenceRepo.insertEvidence({
        ...EVIDENCE,
        runId,
        sourceId: beta,
        quote: '改一次价格要登录四个后台',
        signal: 'seeking',
        supports: '作者在主动寻找替代方案',
      }),
    );
    unwrap(
      await evidenceRepo.insertEvidence({
        ...EVIDENCE,
        runId,
        sourceId: beta,
        quote: '这是被闸门丢掉的改写句',
        quoteOffset: null,
        rejectedReason: 'quote_not_in_snapshot',
      }),
    );
    unwrap(await evidenceRepo.insertEvidence({ ...EVIDENCE, runId: otherRunId, sourceId: other }));

    expect(unwrap(await repo.listAcceptedEvidence(runId))).toEqual([
      {
        id: acceptedFirst.id,
        signal: 'problem',
        platform: 'v2ex',
        supports: '作者在描述自己的库存同步问题',
        quote: '我在三个平台之间手工同步库存',
        sourceId: alpha,
        canonicalUrl: 'https://example.com/alpha',
      },
      {
        id: acceptedSecond.id,
        signal: 'seeking',
        platform: 'v2ex',
        supports: '作者在主动寻找替代方案',
        quote: '改一次价格要登录四个后台',
        sourceId: beta,
        canonicalUrl: 'https://example.com/beta',
      },
    ]);
  });
});

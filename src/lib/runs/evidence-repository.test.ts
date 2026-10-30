import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { Result } from '@/lib/quota/types';

// Type-only namespace imports are erased; the runtime modules are imported
// dynamically below because the db client reads DATABASE_URL at load time.
import type * as ClientModule from '@/lib/db/client';
import type * as EvidenceModule from './evidence-repository';

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

let repo!: typeof EvidenceModule;
let client!: typeof ClientModule;

const previousDatabaseUrl = process.env.DATABASE_URL;

suite('evidence repository', () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    // Static imports cannot work here: the db client reads DATABASE_URL when the
    // module first loads, which is why these suites import it after the env is set.
    repo = await import('./evidence-repository');
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

  async function seedSource(runId: number, canonicalUrl: string): Promise<number> {
    const rows = await client.sql<{ id: number }[]>`
      insert into sources (run_id, canonical_url, platform, content_hash, snapshot_path)
      values (${runId}, ${canonicalUrl}, 'web', ${'a'.repeat(64)}, '/tmp/snapshots/aa/a.txt.gz')
      returning id
    `;
    const row = rows[0];
    if (!row) throw new Error('source insert returned no row');
    return row.id;
  }

  const EVIDENCE: Omit<EvidenceModule.InsertEvidenceInput, 'runId' | 'sourceId'> = {
    quote: '我在三个平台之间手工同步库存',
    quoteOffset: 0,
    platform: 'web',
    publishedAt: null,
    signal: 'problem',
    firstHand: true,
    priceMentioned: null,
    supports: '作者在描述自己的库存同步问题',
    doesNotProve: '不能证明这个问题有多普遍',
    rejectedReason: null,
  };

  it('stores accepted and rejected evidence and counts them separately', async () => {
    const runId = await seedRun();
    const sourceId = await seedSource(runId, 'https://example.com/post');

    unwrap(await repo.insertEvidence({ ...EVIDENCE, runId, sourceId }));
    unwrap(
      await repo.insertEvidence({
        ...EVIDENCE,
        runId,
        sourceId,
        quote: '多平台库存同步非常麻烦',
        quoteOffset: null,
        signal: 'seeking',
        firstHand: false,
        rejectedReason: 'quote_not_in_snapshot',
      }),
    );

    expect(unwrap(await repo.countEvidence(runId, { accepted: true }))).toBe(1);
    expect(unwrap(await repo.countEvidence(runId, { accepted: false }))).toBe(1);

    const rows = await client.sql<
      {
        quote: string;
        quote_offset: number | null;
        rejected_reason: string | null;
        signal: string;
        first_hand: boolean;
      }[]
    >`
      select quote, quote_offset, rejected_reason, signal, first_hand
      from evidence
      order by id
    `;

    expect(rows).toEqual([
      {
        quote: '我在三个平台之间手工同步库存',
        quote_offset: 0,
        rejected_reason: null,
        signal: 'problem',
        first_hand: true,
      },
      {
        quote: '多平台库存同步非常麻烦',
        quote_offset: null,
        rejected_reason: 'quote_not_in_snapshot',
        signal: 'seeking',
        first_hand: false,
      },
    ]);
  });

  it('returns the stored id for a duplicate verdict instead of counting it twice', async () => {
    const runId = await seedRun();
    const sourceId = await seedSource(runId, 'https://example.com/post');

    const first = unwrap(await repo.insertEvidence({ ...EVIDENCE, runId, sourceId }));
    const second = unwrap(await repo.insertEvidence({ ...EVIDENCE, runId, sourceId }));

    expect(first.inserted).toBe(true);
    expect(second).toEqual({ id: first.id, inserted: false });
    expect(unwrap(await repo.countEvidence(runId, { accepted: true }))).toBe(1);
  });

  it('lists only sources without accepted evidence, oldest first and up to the limit', async () => {
    const runId = await seedRun();
    const otherRunId = await seedRun();

    const accepted = await seedSource(runId, 'https://example.com/accepted');
    const rejectedOnly = await seedSource(runId, 'https://example.com/rejected');
    const untouched = await seedSource(runId, 'https://example.com/untouched');
    await seedSource(otherRunId, 'https://example.com/other-run');

    unwrap(await repo.insertEvidence({ ...EVIDENCE, runId, sourceId: accepted }));
    unwrap(
      await repo.insertEvidence({
        ...EVIDENCE,
        runId,
        sourceId: rejectedOnly,
        quote: '这是被丢弃的改写字',
        quoteOffset: null,
        rejectedReason: 'quote_not_in_snapshot',
      }),
    );

    const listed = unwrap(await repo.listSourcesForExtraction(runId, 10));
    expect(listed.map((row) => row.id)).toEqual([rejectedOnly, untouched]);
    expect(listed[0]).toMatchObject({
      canonicalUrl: 'https://example.com/rejected',
      platform: 'web',
      snapshotPath: '/tmp/snapshots/aa/a.txt.gz',
      contentHash: 'a'.repeat(64),
    });

    // A page with only rejected rows is offered again; a fixed gate may accept it.
    expect(unwrap(await repo.listSourcesForExtraction(runId, 1)).map((row) => row.id)).toEqual([
      rejectedOnly,
    ]);

    // Once the retry accepts one quote, the page is done.
    unwrap(await repo.insertEvidence({ ...EVIDENCE, runId, sourceId: rejectedOnly }));
    expect(unwrap(await repo.listSourcesForExtraction(runId, 10)).map((row) => row.id)).toEqual([
      untouched,
    ]);
  });
});

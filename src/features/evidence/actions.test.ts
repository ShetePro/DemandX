import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The db client reads DATABASE_URL when the module first loads, so the runtime
// modules below can only be imported after beforeAll sets it (same pattern as
// the repository integration suites).
import type * as ClientModule from '@/lib/db/client';
import type * as ActionsModule from './actions';
import type * as SnapshotModule from '@/lib/evidence/snapshot';

const mocks = vi.hoisted(() => ({ revalidatePath: vi.fn() }));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));

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

const SNAPSHOT_TEXT = '用户在旺季每天花三小时，在三个平台之间手工同步库存。';

let actions!: typeof ActionsModule;
let client!: typeof ClientModule;
let snapshot!: typeof SnapshotModule;
let snapshotDir = '';
let contentHash = '';

const previousDatabaseUrl = process.env.DATABASE_URL;
const previousSnapshotDir = process.env.SNAPSHOT_DIR;

suite('evidence actions', () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    snapshotDir = await mkdtemp(path.join(tmpdir(), 'demandx-evidence-'));
    process.env.SNAPSHOT_DIR = snapshotDir;

    actions = await import('./actions');
    snapshot = await import('@/lib/evidence/snapshot');
    client = await import('@/lib/db/client');

    const written = await snapshot.writeSnapshot({
      text: SNAPSHOT_TEXT,
      url: 'https://example.com/inventory',
      dir: snapshotDir,
    });
    contentHash = written.hash;
  });

  afterAll(async () => {
    await client.closeDb();
    await rm(snapshotDir, { recursive: true, force: true });

    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
    if (previousSnapshotDir === undefined) delete process.env.SNAPSHOT_DIR;
    else process.env.SNAPSHOT_DIR = previousSnapshotDir;
  });

  beforeEach(async () => {
    mocks.revalidatePath.mockReset();
    await client.sql.unsafe(
      'TRUNCATE evidence, sources, queries, run_events, runs, threads, ideas RESTART IDENTITY CASCADE',
    );
  });

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

  async function seedEvidence(input: {
    runId: number;
    quote: string;
    rejectedReason: string | null;
    quoteOffset: number | null;
  }): Promise<number> {
    const sources = await client.sql<{ id: number }[]>`
      insert into sources (run_id, canonical_url, platform, content_hash)
      values (${input.runId}, 'https://example.com/inventory', 'web', ${contentHash})
      returning id
    `;
    const source = sources[0];
    if (!source) throw new Error('source insert returned no row');

    const rows = await client.sql<{ id: number }[]>`
      insert into evidence (
        run_id, source_id, quote, quote_offset, platform, signal, first_hand,
        supports, does_not_prove, rejected_reason
      ) values (
        ${input.runId}, ${source.id}, ${input.quote}, ${input.quoteOffset}, 'web', 'problem', true,
        '作者描述自己的库存同步问题', '不能证明这个问题有多普遍', ${input.rejectedReason}
      )
      returning id
    `;
    const row = rows[0];
    if (!row) throw new Error('evidence insert returned no row');
    return row.id;
  }

  it('rejects an accepted row and moves it into the rejected count', async () => {
    const runId = await seedRun();
    const id = await seedEvidence({
      runId,
      quote: '手工同步库存',
      rejectedReason: null,
      quoteOffset: 16,
    });

    const result = await actions.rejectEvidenceAction(id);

    expect(result).toEqual({ ok: true, value: { id, rejectedReason: 'manual' } });
    const rows = await client.sql<{ rejected_reason: string | null }[]>`
      select rejected_reason from evidence where id = ${id}
    `;
    expect(rows[0]?.rejected_reason).toBe('manual');
    expect(mocks.revalidatePath).toHaveBeenCalledWith(`/runs/${runId}/evidence`);

    const counts = await client.sql<{ accepted: number; rejected: number }[]>`
      select
        count(*) filter (where rejected_reason is null)::int as accepted,
        count(*) filter (where rejected_reason is not null)::int as rejected
      from evidence where run_id = ${runId}
    `;
    expect(counts[0]).toEqual({ accepted: 0, rejected: 1 });
  });

  it('refuses to restore a quote that no longer occurs in the snapshot', async () => {
    const runId = await seedRun();
    const id = await seedEvidence({
      runId,
      quote: '这句话不在快照里',
      rejectedReason: 'quote_not_in_snapshot',
      quoteOffset: null,
    });

    const result = await actions.restoreEvidenceAction(id);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('QUOTE_MISMATCH');
    expect(mocks.revalidatePath).not.toHaveBeenCalled();

    const rows = await client.sql<
      { rejected_reason: string | null; quote_offset: number | null }[]
    >`
      select rejected_reason, quote_offset from evidence where id = ${id}
    `;
    expect(rows[0]).toEqual({ rejected_reason: 'quote_not_in_snapshot', quote_offset: null });
  });

  it('restores a rejected row after re-running the quote gate', async () => {
    const runId = await seedRun();
    const quote = '在三个平台之间手工同步库存';
    const id = await seedEvidence({
      runId,
      quote,
      rejectedReason: 'quote_not_in_snapshot',
      quoteOffset: null,
    });

    const result = await actions.restoreEvidenceAction(id);

    expect(result).toEqual({
      ok: true,
      value: { id, quoteOffset: SNAPSHOT_TEXT.indexOf(quote), changed: true },
    });
    expect(mocks.revalidatePath).toHaveBeenCalledWith(`/runs/${runId}/evidence`);

    const rows = await client.sql<
      { rejected_reason: string | null; quote_offset: number | null }[]
    >`
      select rejected_reason, quote_offset from evidence where id = ${id}
    `;
    expect(rows[0]).toEqual({ rejected_reason: null, quote_offset: SNAPSHOT_TEXT.indexOf(quote) });
  });

  it('returns a value instead of throwing for an invalid id', async () => {
    const result = await actions.rejectEvidenceAction(0);
    expect(result).toMatchObject({ ok: false, code: 'INVALID_INPUT' });
  });
});

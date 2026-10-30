import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { Result } from '@/lib/quota/types';
// Type-only namespace imports are erased; the runtime modules are imported
// dynamically below because the db client reads DATABASE_URL at load time.
import type * as ClientModule from '@/lib/db/client';
import type * as SourcesModule from './sources-repository';

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

let repo!: typeof SourcesModule;
let client!: typeof ClientModule;

const previousDatabaseUrl = process.env.DATABASE_URL;

suite('sources repository', () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    // Static imports cannot work here: the db client reads DATABASE_URL when the
    // module first loads, which is why these suites import it after the env is set.
    repo = await import('./sources-repository');
    client = await import('@/lib/db/client');
  });

  afterAll(async () => {
    await client.closeDb();

    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
  });

  beforeEach(async () => {
    await client.sql.unsafe(
      'TRUNCATE sources, queries, run_events, runs, threads, ideas RESTART IDENTITY CASCADE',
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

    const threads = await client.sql<{ id: number }[]>`
      insert into threads (idea_id, title) values (${idea.id}, '会话') returning id
    `;
    const thread = threads[0];
    if (!thread) throw new Error('thread insert returned no row');

    const runs = await client.sql<{ id: number }[]>`
      insert into runs (idea_id, thread_id) values (${idea.id}, ${thread.id}) returning id
    `;
    const run = runs[0];
    if (!run) throw new Error('run insert returned no row');

    return run.id;
  }

  const SOURCE: Omit<SourcesModule.InsertSourceInput, 'runId'> = {
    canonicalUrl: 'https://example.com/post',
    platform: 'web',
    contentHash: 'a'.repeat(64),
    snapshotPath: '/tmp/snapshots/aa/a.txt.gz',
    crawlTier: 'static',
  };

  it('inserts a source once and reports the duplicate without growing the table', async () => {
    const runId = await seedRun();

    const first = unwrap(await repo.insertSource({ ...SOURCE, runId }));
    expect(first.inserted).toBe(true);
    expect(unwrap(await repo.countSources(runId))).toBe(1);

    const second = unwrap(await repo.insertSource({ ...SOURCE, runId }));
    expect(second).toEqual({ id: first.id, inserted: false });
    expect(unwrap(await repo.countSources(runId))).toBe(1);
  });

  it('keeps the same URL when its content hash changes', async () => {
    const runId = await seedRun();

    unwrap(await repo.insertSource({ ...SOURCE, runId }));
    const changed = unwrap(
      await repo.insertSource({ ...SOURCE, runId, contentHash: 'b'.repeat(64) }),
    );

    expect(changed.inserted).toBe(true);
    expect(unwrap(await repo.countSources(runId))).toBe(2);
    // The dedupe set is by URL, so a changed page yields one entry.
    expect(unwrap(await repo.listSourceUrls(runId))).toEqual(['https://example.com/post']);
  });

  it('lists only the run’s canonical URLs', async () => {
    const runId = await seedRun();
    const otherRunId = await seedRun();

    unwrap(
      await repo.insertSource({ ...SOURCE, runId, canonicalUrl: 'https://a.example.com/one' }),
    );
    unwrap(
      await repo.insertSource({ ...SOURCE, runId, canonicalUrl: 'https://b.example.com/two/' }),
    );
    unwrap(
      await repo.insertSource({
        ...SOURCE,
        runId: otherRunId,
        canonicalUrl: 'https://c.example.com',
      }),
    );

    expect(unwrap(await repo.listSourceUrls(runId)).sort()).toEqual([
      'https://a.example.com/one',
      'https://b.example.com/two/',
    ]);
  });

  it('records a query with its provider and result count', async () => {
    const runId = await seedRun();

    unwrap(
      await repo.recordQuery({
        runId,
        angle: 'problem',
        provider: 'ddg',
        text: '库存同步 太麻烦',
        resultCount: 3,
      }),
    );

    const rows = await client.sql<{ angle: string; provider: string; result_count: number }[]>`
      select angle, provider, result_count from queries where run_id = ${runId}
    `;
    expect(rows).toEqual([{ angle: 'problem', provider: 'ddg', result_count: 3 }]);
  });
});

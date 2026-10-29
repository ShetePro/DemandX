import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { Result, RunsError } from './repository';
// Type-only namespace imports are erased; the runtime modules are imported
// dynamically below because the db client reads DATABASE_URL at load time.
import type * as ClientModule from '@/lib/db/client';
import type * as RepositoryModule from './repository';

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

const IDEA = '做一个能验证真实付费意愿的需求调研工具';
const ANGLES = ['定价', '获客'];

let repo!: typeof RepositoryModule;
let client!: typeof ClientModule;

const previousDatabaseUrl = process.env.DATABASE_URL;

suite('run repository', () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    repo = await import('./repository');
    client = await import('@/lib/db/client');
  });

  afterAll(async () => {
    await client.closeDb();

    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
  });

  beforeEach(async () => {
    // CASCADE also clears llm_chains/provider_models through their provider FK.
    await client.sql.unsafe(
      'TRUNCATE run_events, messages, runs, threads, ideas, providers RESTART IDENTITY CASCADE',
    );
  });

  function unwrap<T>(result: Result<T>): T {
    if (!result.ok) throw new Error(`expected ok, got ${result.code}: ${result.message}`);
    return result.value;
  }

  function expectFailure<T>(result: Result<T>): RunsError {
    if (result.ok) throw new Error('expected a failure result, got ok');
    return result;
  }

  async function seedQualityChain(): Promise<number> {
    const rows = await client.sql<
      { id: number }[]
    >`insert into providers (name, kind, base_url, enabled) values ('Local', 'ollama', 'http://127.0.0.1:11434', true) returning id`;
    const provider = rows[0];
    if (!provider) throw new Error('provider insert returned no row');

    await client.sql`insert into llm_chains (profile, position, provider_id, model_id) values ('quality', 0, ${provider.id}, 'qwen2.5:7b')`;
    return provider.id;
  }

  async function createThreadWithRun() {
    const thread = unwrap(await repo.createThread({ title: '会话', idea: IDEA }));
    const run = unwrap(await repo.createRun({ threadId: thread.threadId, idea: IDEA }));
    return { thread, run };
  }

  it('creates a thread that always has an idea row, with or without a pitch', async () => {
    const withPitch = unwrap(await repo.createThread({ title: '有想法', idea: IDEA }));
    const withoutPitch = unwrap(await repo.createThread({ title: '还没有想法' }));

    const rows = await client.sql<
      { id: number; title: string; raw_input: string }[]
    >`select id, title, raw_input from ideas order by id`;
    expect(rows).toEqual([
      { id: withPitch.ideaId, title: '有想法', raw_input: IDEA },
      { id: withoutPitch.ideaId, title: '还没有想法', raw_input: '' },
    ]);

    const thread = unwrap(await repo.getThread(withPitch.threadId));
    expect(thread).toMatchObject({ id: withPitch.threadId, ideaId: withPitch.ideaId });
  });

  it('rejects blank titles and ideas without touching the database', async () => {
    expect(expectFailure(await repo.createThread({ title: '   ' })).code).toBe('VALIDATION_FAILED');

    const { run } = await createThreadWithRun();
    expect(expectFailure(await repo.createRun({ threadId: run.threadId, idea: '' })).code).toBe(
      'VALIDATION_FAILED',
    );
  });

  it('writes the run, the user message, the chain snapshot and run.created together', async () => {
    const providerId = await seedQualityChain();
    const thread = unwrap(await repo.createThread({ title: '会话' }));
    const created = unwrap(
      await repo.createRun({ threadId: thread.threadId, idea: IDEA, angles: ANGLES }),
    );

    const runRows = await client.sql<
      {
        id: number;
        idea_id: number;
        thread_id: number;
        status: string;
        stage: string;
        chain_snapshot: unknown;
        deadline_at: string;
        created_at: string;
      }[]
    >`select id, idea_id, thread_id, status, stage, chain_snapshot, deadline_at, created_at from runs where id = ${created.runId}`;
    const runRow = runRows[0];
    if (!runRow) throw new Error('run row missing');

    expect(runRow).toMatchObject({
      id: created.runId,
      idea_id: thread.ideaId,
      thread_id: thread.threadId,
      status: 'queued',
      stage: 'S0',
    });
    expect(runRow.chain_snapshot).toEqual([
      {
        providerId,
        providerName: 'Local',
        kind: 'ollama',
        baseUrl: 'http://127.0.0.1:11434',
        headers: {},
        modelId: 'qwen2.5:7b',
      },
    ]);
    expect(new Date(runRow.deadline_at).getTime() - new Date(runRow.created_at).getTime()).toBe(
      90 * 60 * 1000,
    );

    // A thread created without a pitch gets the first real idea filled in.
    const ideaRows = await client.sql<
      { raw_input: string }[]
    >`select raw_input from ideas where id = ${thread.ideaId}`;
    expect(ideaRows[0]?.raw_input).toBe(IDEA);

    const messages = unwrap(await repo.getMessages(thread.threadId));
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ threadId: thread.threadId, role: 'user' });
    expect(messages[0]?.parts).toEqual([{ type: 'text', text: IDEA }]);

    const events = unwrap(await repo.readEvents(created.runId, 0));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ seq: 1, type: 'run.created' });
    expect(events[0]?.payload).toEqual({ idea: IDEA, angles: ANGLES });

    const run = unwrap(await repo.getRun(created.runId));
    expect(run).toMatchObject({
      id: created.runId,
      ideaId: thread.ideaId,
      threadId: thread.threadId,
      status: 'queued',
      stage: 'S0',
    });
  });

  it('creates the thread when createRun is given an id that does not exist', async () => {
    const created = unwrap(await repo.createRun({ threadId: 999_999, idea: IDEA }));

    expect(created.threadId).not.toBe(999_999);
    const run = unwrap(await repo.getRun(created.runId));
    expect(run?.threadId).toBe(created.threadId);

    const thread = unwrap(await repo.getThread(created.threadId));
    expect(thread?.title).toBe(IDEA);
  });

  it('assigns unique consecutive seqs to concurrent appends', async () => {
    const { run } = await createThreadWithRun();

    const results = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        repo.appendEvent(run.runId, 'stage.progress', { index }),
      ),
    );
    const seqs = results.map((result) => unwrap(result).seq).sort((a, b) => a - b);

    expect(seqs).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);

    const stored = unwrap(await repo.readEvents(run.runId, 0));
    expect(stored).toHaveLength(11);
    expect(new Set(stored.map((event) => event.seq)).size).toBe(11);
  });

  it('readEvents returns only later events, oldest first', async () => {
    const { run } = await createThreadWithRun();
    unwrap(await repo.appendEvent(run.runId, 'stage.started', { stage: 'S1' }));
    unwrap(await repo.appendEvent(run.runId, 'stage.progress', { done: 1 }));
    unwrap(await repo.appendEvent(run.runId, 'stage.finished', { stage: 'S1' }));

    const all = unwrap(await repo.readEvents(run.runId, 0));
    expect(all.map((event) => event.seq)).toEqual([1, 2, 3, 4]);
    expect(all.map((event) => event.type)).toEqual([
      'run.created',
      'stage.started',
      'stage.progress',
      'stage.finished',
    ]);

    const tail = unwrap(await repo.readEvents(run.runId, 2));
    expect(tail.map((event) => event.seq)).toEqual([3, 4]);
    expect(tail.map((event) => event.type)).toEqual(['stage.progress', 'stage.finished']);

    expect(unwrap(await repo.readEvents(run.runId, 4))).toEqual([]);
    // A negative cursor is clamped to the start, not passed to SQL.
    expect(unwrap(await repo.readEvents(run.runId, -1))).toHaveLength(4);
  });

  it('reports a missing run instead of appending an orphan event', async () => {
    const failure = expectFailure(await repo.appendEvent(424_242, 'stage.progress', {}));
    expect(failure.code).toBe('NOT_FOUND');

    const rows = await client.sql<{ count: number }[]>`
      select count(*)::int as count from run_events where run_id = ${424_242}
    `;
    expect(rows[0]?.count).toBe(0);
  });

  it('keeps the chain snapshot frozen after the configured chain changes', async () => {
    const providerId = await seedQualityChain();
    const thread = unwrap(await repo.createThread({ title: '快照', idea: IDEA }));
    const created = unwrap(await repo.createRun({ threadId: thread.threadId, idea: IDEA }));

    await client.sql`update llm_chains set model_id = 'llama3.2:3b' where profile = 'quality' and position = 0`;

    const run = unwrap(await repo.getRun(created.runId));
    const rows = await client.sql<
      { chain_snapshot: { modelId: string; providerId: number }[] }[]
    >`select chain_snapshot from runs where id = ${created.runId}`;

    expect(run).not.toBeNull();
    expect(rows[0]?.chain_snapshot).toEqual([
      expect.objectContaining({ providerId, modelId: 'qwen2.5:7b' }),
    ]);
  });
});

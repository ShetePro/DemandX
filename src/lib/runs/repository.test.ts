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

  it('creates idea, thread, first message and run together for createResearch', async () => {
    const created = unwrap(await repo.createResearch({ idea: IDEA }));

    const thread = unwrap(await repo.getThread(created.threadId));
    expect(thread).toMatchObject({ ideaId: created.ideaId, title: IDEA });

    const ideaRows = await client.sql<
      { raw_input: string }[]
    >`select raw_input from ideas where id = ${created.ideaId}`;
    expect(ideaRows[0]?.raw_input).toBe(IDEA);

    const messages = unwrap(await repo.getMessages(created.threadId));
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ threadId: created.threadId, role: 'user' });
    expect(messages[0]?.parts).toEqual([{ type: 'text', text: IDEA }]);

    const run = unwrap(await repo.getRun(created.runId));
    expect(run).toMatchObject({ threadId: created.threadId, status: 'queued' });
  });

  it('rejects a createResearch idea shorter than 8 characters', async () => {
    expect(expectFailure(await repo.createResearch({ idea: '太短' })).code).toBe(
      'VALIDATION_FAILED',
    );
  });

  it('stores the assistant turn once and reports the existing row afterwards', async () => {
    const thread = unwrap(await repo.createThread({ title: '自动回复', idea: IDEA }));
    expect(unwrap(await repo.hasAssistantMessage(thread.threadId))).toBe(false);

    const first = unwrap(
      await repo.appendAssistantMessage(thread.threadId, [
        { type: 'reasoning', text: '先确认价格页。' },
        { type: 'text', text: '付费意愿集中在旺季 [e12]。' },
      ]),
    );
    expect(first.inserted).toBe(true);
    expect(unwrap(await repo.hasAssistantMessage(thread.threadId))).toBe(true);

    // A reloaded page may finish the same turn again; the retry is dropped.
    const retry = unwrap(
      await repo.appendAssistantMessage(thread.threadId, [
        { type: 'reasoning', text: '先确认价格页。' },
        { type: 'text', text: '付费意愿集中在旺季 [e12]。' },
      ]),
    );
    expect(retry).toEqual({ inserted: false, id: first.id });

    // A later chat turn is a different answer and must be kept.
    const second = unwrap(
      await repo.appendAssistantMessage(thread.threadId, [{ type: 'text', text: '第二份答案' }]),
    );
    expect(second.inserted).toBe(true);

    const stored = unwrap(await repo.getMessages(thread.threadId));
    const assistant = stored.filter((message) => message.role === 'assistant');
    expect(assistant).toHaveLength(2);
    expect(assistant[0]?.parts).toEqual([
      { type: 'reasoning', text: '先确认价格页。' },
      { type: 'text', text: '付费意愿集中在旺季 [e12]。' },
    ]);
    expect(assistant[1]?.parts).toEqual([{ type: 'text', text: '第二份答案' }]);
  });

  it('reports a missing thread instead of storing an orphan answer', async () => {
    const failure = expectFailure(
      await repo.appendAssistantMessage(424_242, [{ type: 'text', text: '孤儿回复' }]),
    );
    expect(failure.code).toBe('NOT_FOUND');
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

  it('writes the run state a worker owns, including the terminal timestamp', async () => {
    const { run } = await createThreadWithRun();
    const startedAt = new Date('2026-10-30T01:00:00.000Z');
    const deadlineAt = new Date('2026-10-30T02:30:00.000Z');
    const finishedAt = new Date('2026-10-30T01:30:00.000Z');

    unwrap(
      await repo.setRunState(run.runId, {
        status: 'running',
        stage: 'S1',
        startedAt,
        deadlineAt,
        finishedAt: null,
        error: null,
      }),
    );

    const running = await client.sql<
      {
        status: string;
        stage: string;
        started_at: Date;
        deadline_at: Date;
        finished_at: Date | null;
        error: unknown;
      }[]
    >`select status, stage, started_at, deadline_at, finished_at, error from runs where id = ${run.runId}`;
    const runningRow = running[0];
    if (!runningRow) throw new Error('run row missing');

    expect(runningRow.status).toBe('running');
    expect(runningRow.stage).toBe('S1');
    expect(new Date(runningRow.started_at)).toEqual(startedAt);
    expect(new Date(runningRow.deadline_at)).toEqual(deadlineAt);
    expect(runningRow.finished_at).toBeNull();
    expect(runningRow.error).toBeNull();

    unwrap(
      await repo.setRunState(run.runId, {
        status: 'finished',
        stage: 'S1',
        finishedAt,
      }),
    );

    const finished = await client.sql<
      { status: string; stage: string; finished_at: Date | null }[]
    >`select status, stage, finished_at from runs where id = ${run.runId}`;
    expect(finished[0]?.status).toBe('finished');
    expect(finished[0]?.stage).toBe('S1');
    expect(finished[0]?.finished_at ? new Date(finished[0].finished_at) : null).toEqual(finishedAt);
  });

  it('stores a structured failure and rejects unknown states', async () => {
    const { run } = await createThreadWithRun();

    unwrap(
      await repo.setRunState(run.runId, {
        status: 'failed',
        stage: 'S1',
        error: { code: 'DEADLINE_EXCEEDED', message: '超时' },
      }),
    );

    const rows = await client.sql<
      { status: string; error: { code: string; message: string } }[]
    >`select status, error from runs where id = ${run.runId}`;
    expect(rows[0]).toMatchObject({
      status: 'failed',
      error: { code: 'DEADLINE_EXCEEDED', message: '超时' },
    });

    expect(expectFailure(await repo.setRunState(run.runId, { status: 'nope' })).code).toBe(
      'VALIDATION_FAILED',
    );
    expect(expectFailure(await repo.setRunState(424_242, { status: 'running' })).code).toBe(
      'NOT_FOUND',
    );
  });

  it('lists the newest runs first with the idea title and report summary', async () => {
    const first = await createThreadWithRun();
    await client.sql`update ideas set title = '第一个方向' where id = ${first.thread.ideaId}`;
    const second = await createThreadWithRun();
    await client.sql`update ideas set title = '第二个方向' where id = ${second.thread.ideaId}`;
    await client.sql`insert into reports (run_id, sections, rubric_total, credibility_grade, decision) values (${second.run.runId}, '{}'::jsonb, 78, 'B', '建议先验证，再开发')`;

    const rows = unwrap(await repo.listRuns(4));

    expect(rows.map((row) => row.id)).toEqual([second.run.runId, first.run.runId]);
    expect(rows[0]).toMatchObject({
      ideaTitle: '第二个方向',
      status: 'queued',
      hasReport: true,
      rubricTotal: 78,
      credibilityGrade: 'B',
      decision: '建议先验证，再开发',
    });
    expect(rows[1]).toMatchObject({
      ideaTitle: '第一个方向',
      hasReport: false,
      rubricTotal: null,
      credibilityGrade: null,
      decision: null,
    });
    expect(rows[1]?.updatedAt).toBeInstanceOf(Date);
    expect(unwrap(await repo.listRuns(1))).toHaveLength(1);
  });

  it('summarises every conversation by its newest run, and the report behind it', async () => {
    const idle = unwrap(await repo.createThread({ title: '还没有研究', idea: IDEA }));

    const ran = unwrap(await repo.createThread({ title: '正在跑', idea: IDEA }));
    const firstRun = unwrap(await repo.createRun({ threadId: ran.threadId, idea: IDEA }));
    await client.sql`update runs set status = 'failed', stage = 'S1' where id = ${firstRun.runId}`;
    const secondRun = unwrap(await repo.createRun({ threadId: ran.threadId, idea: IDEA }));
    await client.sql`update runs set status = 'running', stage = 'S3', started_at = now() where id = ${secondRun.runId}`;

    const done = unwrap(await repo.createThread({ title: '已完成', idea: IDEA }));
    const doneRun = unwrap(await repo.createRun({ threadId: done.threadId, idea: IDEA }));
    await client.sql`update runs set status = 'finished', stage = 'S6', started_at = now(), finished_at = now() where id = ${doneRun.runId}`;
    await client.sql`insert into reports (run_id, sections, rubric_total, credibility_grade, decision) values (${doneRun.runId}, '{}'::jsonb, 78, 'B', '建议先验证，再开发')`;

    const rows = unwrap(await repo.listThreadSummaries(10));
    const byId = new Map(rows.map((row) => [row.id, row]));

    expect(byId.get(idle.threadId)).toMatchObject({
      title: '还没有研究',
      status: 'not_started',
      stage: null,
      score: null,
      grade: null,
      decision: null,
      hasReport: false,
    });
    expect(byId.get(idle.threadId)?.updatedAt).toBeInstanceOf(Date);

    // Two runs: the newer one is the conversation's state, never the older one.
    expect(byId.get(ran.threadId)).toMatchObject({
      status: 'running',
      stage: 'S3',
      score: null,
      hasReport: false,
    });

    expect(byId.get(done.threadId)).toMatchObject({
      status: 'finished',
      stage: 'S6',
      score: 78,
      grade: 'B',
      decision: '建议先验证，再开发',
      hasReport: true,
    });

    expect(unwrap(await repo.listThreadSummaries(1))).toHaveLength(1);
  });

  it('deletes a conversation with its messages, idea, runs and events', async () => {
    const { thread, run } = await createThreadWithRun();
    unwrap(await repo.appendAssistantMessage(thread.threadId, [{ type: 'text', text: '回答' }]));
    unwrap(await repo.appendEvent(run.runId, 'stage.started', { stage: 'S1' }));

    expect(unwrap(await repo.deleteThread(thread.threadId))).toEqual({
      threadId: thread.threadId,
      ideaDeleted: true,
    });

    const [counts] = await client.sql<
      { threads: number; messages: number; ideas: number; runs: number; events: number }[]
    >`select
        (select count(*)::int from threads) as threads,
        (select count(*)::int from messages) as messages,
        (select count(*)::int from ideas) as ideas,
        (select count(*)::int from runs) as runs,
        (select count(*)::int from run_events) as events`;
    expect(counts).toEqual({ threads: 0, messages: 0, ideas: 0, runs: 0, events: 0 });
  });

  it('keeps the idea and its runs when another conversation still uses them', async () => {
    const { thread, run } = await createThreadWithRun();
    await client.sql`
      insert into threads (idea_id, title)
      select idea_id, '共享想法' from threads where id = ${thread.threadId}
    `;

    expect(unwrap(await repo.deleteThread(thread.threadId))).toEqual({
      threadId: thread.threadId,
      ideaDeleted: false,
    });

    const [idea] = await client.sql<{ ideas: number }[]>`
      select count(*)::int as ideas from ideas
    `;
    expect(idea?.ideas).toBe(1);

    const [storedRun] = await client.sql<{ thread_id: number | null }[]>`
      select thread_id from runs where id = ${run.runId}
    `;
    expect(storedRun?.thread_id).toBeNull();
  });

  it('rejects deleting a conversation that does not exist', async () => {
    expect(expectFailure(await repo.deleteThread(424_242)).code).toBe('NOT_FOUND');
    expect(expectFailure(await repo.deleteThread(0)).code).toBe('VALIDATION_FAILED');
  });
});

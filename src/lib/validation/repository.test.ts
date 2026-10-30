import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

// The db client reads DATABASE_URL when the module first loads, so the runtime
// modules below can only be imported after beforeAll sets it; a static import
// would bind the pool to the wrong database.
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

let repo!: typeof RepositoryModule;
let client!: typeof ClientModule;

const previousDatabaseUrl = process.env.DATABASE_URL;

suite('validation repository', () => {
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
    await client.sql.unsafe(
      'TRUNCATE validation_tasks, run_events, messages, runs, threads, ideas, providers RESTART IDENTITY CASCADE',
    );
  });

  function unwrap<T>(result: { ok: true; value: T } | { ok: false; message: string }): T {
    if (!result.ok) throw new Error(`expected ok, got: ${result.message}`);
    return result.value;
  }

  async function seedRun(): Promise<number> {
    const ideas = await client.sql<
      { id: number }[]
    >`insert into ideas (title, raw_input) values ('验证计划', '一个真实想法') returning id`;
    const idea = ideas[0];
    if (!idea) throw new Error('idea insert returned no row');

    const runs = await client.sql<
      { id: number }[]
    >`insert into runs (idea_id, status, stage) values (${idea.id}, 'finished', 'S6') returning id`;
    const run = runs[0];
    if (!run) throw new Error('run insert returned no row');
    return run.id;
  }

  it('materialises the 14-day template once and lists it in day order', async () => {
    const runId = await seedRun();

    const created = unwrap(await repo.ensurePlan(runId));
    expect(created).toHaveLength(14);
    expect(created.map((task) => task.day)).toEqual(
      Array.from({ length: 14 }, (_, index) => index + 1),
    );
    expect(created.every((task) => task.done === false)).toBe(true);
    expect(created.every((task) => task.runId === runId)).toBe(true);

    const listed = unwrap(await repo.listPlan(runId));
    expect(listed).toEqual(created);

    // A second visit returns the same rows instead of appending another plan.
    const again = unwrap(await repo.ensurePlan(runId));
    expect(again.map((task) => task.id)).toEqual(created.map((task) => task.id));

    const rows = await client.sql<
      { count: number }[]
    >`select count(*)::int as count from validation_tasks where run_id = ${runId}`;
    expect(rows[0]?.count).toBe(14);
  });

  it('serialises concurrent ensurePlan calls into one plan', async () => {
    const runId = await seedRun();

    const [first, second] = await Promise.all([repo.ensurePlan(runId), repo.ensurePlan(runId)]);

    const firstIds = unwrap(first).map((task) => task.id);
    const secondIds = unwrap(second).map((task) => task.id);
    expect(firstIds).toEqual(secondIds);

    const rows = await client.sql<
      { count: number }[]
    >`select count(*)::int as count from validation_tasks where run_id = ${runId}`;
    expect(rows[0]?.count).toBe(14);
  });

  it('toggles one task without touching the rest', async () => {
    const runId = await seedRun();
    const tasks = unwrap(await repo.ensurePlan(runId));
    const target = tasks[0];
    if (!target) throw new Error('plan has no tasks');

    const checked = unwrap(await repo.toggleTask(target.id, true));
    expect(checked).toMatchObject({ id: target.id, runId, done: true });

    const listed = unwrap(await repo.listPlan(runId));
    expect(listed.filter((task) => task.done)).toHaveLength(1);
    expect(listed.find((task) => task.id === target.id)?.done).toBe(true);

    const unchecked = unwrap(await repo.toggleTask(target.id, false));
    expect(unchecked.done).toBe(false);
  });

  it('rejects unknown tasks, invalid input and missing runs', async () => {
    const runId = await seedRun();
    const tasks = unwrap(await repo.ensurePlan(runId));
    const target = tasks[0];
    if (!target) throw new Error('plan has no tasks');

    const missingTask = await repo.toggleTask(999_999, true);
    expect(missingTask.ok).toBe(false);
    if (!missingTask.ok) expect(missingTask.code).toBe('NOT_FOUND');

    const badDone = await repo.toggleTask(target.id, 'yes');
    expect(badDone.ok).toBe(false);
    if (!badDone.ok) expect(badDone.code).toBe('VALIDATION_FAILED');

    const badId = await repo.toggleTask(0, true);
    expect(badId.ok).toBe(false);
    if (!badId.ok) expect(badId.code).toBe('VALIDATION_FAILED');

    const missingRun = await repo.ensurePlan(424_242);
    expect(missingRun.ok).toBe(false);
    if (!missingRun.ok) expect(missingRun.code).toBe('NOT_FOUND');

    expect(unwrap(await repo.listPlan(runId))).toHaveLength(14);
  });
});

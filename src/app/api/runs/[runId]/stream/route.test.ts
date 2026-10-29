import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { Result } from '@/lib/runs/repository';
// Type-only namespace imports are erased; the runtime modules below are
// imported dynamically because the db client reads DATABASE_URL at load time.
import type * as ClientModule from '@/lib/db/client';
import type * as RepositoryModule from '@/lib/runs/repository';
import type * as RouteModule from './route';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL?.trim() ?? '';

/** Database name from a postgres URL, or '' when it cannot be parsed. */
function databaseName(url: string): string {
  try {
    return new URL(url).pathname.replace(/^\//, '');
  } catch {
    return '';
  }
}

// The suite TRUNCATEs tables. Refuse anything that is not an explicitly named
// `*_test` database, even if a bad URL is passed in.
if (TEST_DATABASE_URL && !databaseName(TEST_DATABASE_URL).endsWith('_test')) {
  throw new Error(
    `拒绝在非 _test 数据库上运行集成测试：${
      databaseName(TEST_DATABASE_URL) || '(无法解析数据库名)'
    }。TEST_DATABASE_URL 的库名必须以 _test 结尾。`,
  );
}

const suite = TEST_DATABASE_URL ? describe : describe.skip;

const IDEA = '验证可续传事件流';
const BASE_URL = 'http://127.0.0.1:3000';
/** A regression that never closes the stream must fail, not hang CI. */
const STREAM_TIMEOUT_MS = 5_000;

let repo!: typeof RepositoryModule;
let client!: typeof ClientModule;
let route!: typeof RouteModule;

const previousDatabaseUrl = process.env.DATABASE_URL;

suite('GET /api/runs/[runId]/stream', () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    repo = await import('@/lib/runs/repository');
    client = await import('@/lib/db/client');
    route = await import('./route');
  });

  afterAll(async () => {
    await client.closeDb();

    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
  });

  beforeEach(async () => {
    await client.sql.unsafe(
      'TRUNCATE run_events, messages, runs, threads, ideas RESTART IDENTITY CASCADE',
    );
  });

  function unwrap<T>(result: Result<T>): T {
    if (!result.ok) throw new Error(`expected ok, got ${result.code}: ${result.message}`);
    return result.value;
  }

  function callRoute(
    runId: string,
    query = '',
    headers: Record<string, string> = {},
  ): Promise<Response> {
    return route.GET(new Request(`${BASE_URL}/api/runs/${runId}/stream${query}`, { headers }), {
      params: Promise.resolve({ runId }),
    });
  }

  /** run.created is seq 1; every append after it lands at 2, 3, … */
  async function seedFinishedRun(appends: number): Promise<number> {
    const thread = unwrap(await repo.createThread({ title: '流测试', idea: IDEA }));
    const run = unwrap(await repo.createRun({ threadId: thread.threadId, idea: IDEA }));

    for (let index = 0; index < appends; index += 1) {
      const type = index === 0 ? 'stage.started' : 'stage.progress';
      unwrap(await repo.appendEvent(run.runId, type, { index }));
    }

    await client.sql`update runs set status = 'finished' where id = ${run.runId}`;
    return run.runId;
  }

  it(
    'flushes every remaining event of a finished run, then closes',
    { timeout: STREAM_TIMEOUT_MS },
    async () => {
      const runId = await seedFinishedRun(2);

      const response = await callRoute(String(runId));
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/event-stream');

      // Resolving at all proves the stream closed itself instead of hanging.
      const body = await response.text();
      expect(body).toContain(
        'id: 1\nevent: run.created\ndata: {"idea":"验证可续传事件流","angles":[]}',
      );
      expect(body).toContain('id: 2\nevent: stage.started\ndata: {"index":0}');
      expect(body).toContain('id: 3\nevent: stage.progress\ndata: {"index":1}');
      expect([...body.matchAll(/^id: /gm)]).toHaveLength(3);
    },
  );

  it(
    'resumes after after_seq and Last-Event-ID without repeating events',
    { timeout: STREAM_TIMEOUT_MS },
    async () => {
      const runId = await seedFinishedRun(1);

      const resumed = await callRoute(String(runId), '?after_seq=1');
      const resumedBody = await resumed.text();
      expect(resumedBody).not.toContain('id: 1\nevent: run.created');
      expect(resumedBody).toContain('id: 2\nevent: stage.started');
      expect([...resumedBody.matchAll(/^id: /gm)]).toHaveLength(1);

      const started = Date.now();
      const empty = await callRoute(String(runId), '', { 'Last-Event-ID': '2' });
      const emptyBody = await empty.text();
      const elapsed = Date.now() - started;

      // Nothing after seq 2: no event frame, only a possible heartbeat comment.
      expect(emptyBody).not.toMatch(/^id: /m);
      expect(emptyBody).not.toContain('stage.started');
      expect(elapsed).toBeLessThan(1_500);
    },
  );

  it('answers an unknown run with a 404 JSON body', async () => {
    const response = await callRoute('999999');

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: 'run_not_found',
      message: 'Run 不存在',
    });
  });
});

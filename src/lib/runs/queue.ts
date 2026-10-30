import { PgBoss } from 'pg-boss';

/**
 * Queue name shared by the producer (server action) and the worker. pg-boss 12
 * rejects `pipeline:s1` — names allow only `[A-Za-z0-9_.-/]` — so the stage is
 * addressed with the equivalent slash form.
 */
export const S1_QUEUE = 'pipeline/s1';

/** One retry after the first failure; a second failure is terminal. */
export const S1_RETRY_LIMIT = 2;

/** 90 minutes matches the run deadline the repository stamps on a run. */
export const S1_EXPIRE_SECONDS = 90 * 60;

export type QueueErrorCode = 'INVALID_INPUT' | 'STORAGE_FAILED';

/** Enqueue failures cross the boundary as values, never as exceptions. */
export type QueueResult<T> =
  { ok: true; value: T } | { ok: false; code: QueueErrorCode; message: string };

export interface EnqueueS1Options {
  /** Defaults to `DATABASE_URL`; injected by tests. */
  connectionString?: string;
}

export interface EnqueueS1Result {
  /** `null` when pg-boss deduplicated the job against an identical active one. */
  jobId: string | null;
}

/**
 * Enqueue the S1 stage for a run. Deliberately self-contained: a short-lived
 * boss instance connects, sends, and stops, so the Next server never keeps a
 * queue connection (or a background supervisor) alive between requests.
 * Failure is returned as a value — the caller has already created the run, and
 * losing it because the queue is down would be worse than a stuck run.
 */
export async function enqueueS1(
  runId: number,
  options: EnqueueS1Options = {},
): Promise<QueueResult<EnqueueS1Result>> {
  if (!Number.isInteger(runId) || runId <= 0) {
    return { ok: false, code: 'INVALID_INPUT', message: `run ${runId} 不是合法的 run id` };
  }

  const connectionString = options.connectionString ?? process.env.DATABASE_URL;
  if (connectionString === undefined || connectionString.trim() === '') {
    return { ok: false, code: 'STORAGE_FAILED', message: 'DATABASE_URL 未设置，无法入队' };
  }

  let boss: PgBoss | undefined;
  try {
    boss = new PgBoss(connectionString);
    // Without a listener, EventEmitter would throw on the first emitted error.
    boss.on('error', (error) => {
      console.error('❌ pg-boss:', error);
    });

    await boss.start();
    // pg-boss 12 refuses to send to a queue that was never created; create is
    // idempotent, so both producer and worker may call it.
    await boss.createQueue(S1_QUEUE, {
      retryLimit: S1_RETRY_LIMIT,
      retryDelay: 30,
      retryBackoff: true,
      expireInSeconds: S1_EXPIRE_SECONDS,
    });

    const jobId = await boss.send(
      S1_QUEUE,
      { runId },
      { singletonKey: String(runId), retryLimit: S1_RETRY_LIMIT },
    );
    return { ok: true, value: { jobId } };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, code: 'STORAGE_FAILED', message: `S1 入队失败: ${message}` };
  } finally {
    // A failed stop must not mask the enqueue outcome.
    await boss?.stop({ graceful: false }).catch(() => undefined);
  }
}

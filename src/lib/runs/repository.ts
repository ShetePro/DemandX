import { and, asc, desc, eq, gt, sql } from 'drizzle-orm';
import { z } from 'zod';

import { db, type Database } from '@/lib/db/client';
import { ideas, messages, runEvents, runs, threads } from '@/lib/db/schema';
import { getChain } from '@/lib/llm/chain-repository';

/** Run states after which no further events are expected. */
export const TERMINAL_RUN_STATUSES: Readonly<Record<string, true>> = {
  finished: true,
  failed: true,
  cancelled: true,
};

/** One page of the event log. A client that fell further behind reconnects. */
export const EVENT_PAGE_SIZE = 500;

/** How long a run may stay open before the worker must give up on it. */
const RUN_DEADLINE_MINUTES = 90;

export type RunsErrorCode = 'VALIDATION_FAILED' | 'NOT_FOUND' | 'STORAGE_FAILED';

export type RunsError = { code: RunsErrorCode; message: string };

/** A failure that crosses a layer boundary without throwing. */
export type Result<T> = { ok: true; value: T } | ({ ok: false } & RunsError);

type Failure = Extract<Result<unknown>, { ok: false }>;

function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

function fail<T>(code: RunsErrorCode, message: string): Result<T> {
  return { ok: false, code, message };
}

/** SQLSTATE only: postgres.js errors also carry query text and parameters. */
function storageFailure<T>(action: string, error: unknown): Result<T> {
  const state = (error as { code?: unknown } | null)?.code;
  const detail = typeof state === 'string' ? ` (SQLSTATE ${state})` : '';
  return fail('STORAGE_FAILED', `${action}失败${detail}`);
}

export function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.length > 0 ? issue.path.join('.') : '(root)'}: ${issue.message}`)
    .join('; ');
}

/** Every write below returns a row; an empty result is a programming error. */
function firstRow<T>(rows: T[]): T {
  const row = rows[0];
  if (!row) throw new Error('expected the statement to return a row');
  return row;
}

export const createThreadInputSchema = z.strictObject({
  title: z.string().trim().min(1, '标题不能为空').max(120, '标题最多 120 个字符'),
  /** The raw pitch, when the caller already has one. */
  idea: z.string().trim().max(4000, '想法最多 4000 个字符').optional(),
});

export type CreateThreadInput = z.input<typeof createThreadInputSchema>;

export type CreateThreadResult = { threadId: number; ideaId: number };

/**
 * A thread always hangs off an idea row (`threads.idea_id` is NOT NULL), so a
 * conversation opened before the pitch exists keeps an empty `raw_input`; the
 * first `createRun` with an idea fills it in.
 */
export async function createThread(input: CreateThreadInput): Promise<Result<CreateThreadResult>> {
  const parsed = createThreadInputSchema.safeParse(input);
  if (!parsed.success) return fail('VALIDATION_FAILED', formatIssues(parsed.error));

  const { title, idea } = parsed.data;

  try {
    const created = await db.transaction(async (tx) => {
      const ideaRow = firstRow(
        await tx
          .insert(ideas)
          .values({ title, rawInput: idea ?? '' })
          .returning({ id: ideas.id }),
      );
      const threadRow = firstRow(
        await tx
          .insert(threads)
          .values({ ideaId: ideaRow.id, title })
          .returning({ id: threads.id }),
      );
      return { threadId: threadRow.id, ideaId: ideaRow.id };
    });

    return ok(created);
  } catch (error) {
    return storageFailure('创建会话', error);
  }
}

export const createRunInputSchema = z.strictObject({
  threadId: z.number().int('threadId 必须是整数').positive('threadId 必须为正数'),
  idea: z.string().trim().min(1, '想法不能为空').max(4000, '想法最多 4000 个字符'),
  angles: z
    .array(z.string().trim().min(1, '角度不能为空').max(60, '角度最多 60 个字符'))
    .max(8, '角度最多 8 个')
    .optional(),
});

export type CreateRunInput = z.input<typeof createRunInputSchema>;

export type CreateRunResult = { runId: number; threadId: number };

/** Carries an event-write failure out of the transaction so it rolls back. */
class EventWriteError extends Error {
  constructor(readonly failure: Failure) {
    super(failure.message);
    this.name = 'EventWriteError';
  }
}

async function insertEvent(
  exec: Pick<Database, 'execute'>,
  runId: number,
  type: string,
  payload: unknown,
): Promise<number | null> {
  // `seq` comes from the log itself so callers never invent a cursor. The
  // scalar aggregate turns the insert into "next position in this run's log".
  const rows = await exec.execute<{ seq: number }>(sql`
    insert into run_events (run_id, seq, type, payload)
    select ${runId}, coalesce(max(seq), 0) + 1, ${type}, ${JSON.stringify(payload)}::jsonb
    from run_events
    where run_id = ${runId}
    returning seq
  `);

  const row = rows[0];
  return row ? row.seq : null;
}

/**
 * Lock the run row before reading `max(seq)`. Two appends that both compute
 * the same next seq would otherwise collide on the unique index; the lock
 * makes them queue instead. The insert stays a single `INSERT … SELECT`.
 */
async function lockRun(exec: Pick<Database, 'execute'>, runId: number): Promise<boolean> {
  const rows = await exec.execute<{ id: number }>(
    sql`select id from runs where id = ${runId} for update`,
  );
  return rows.length > 0;
}

async function appendWith(
  exec: Pick<Database, 'execute'>,
  runId: number,
  type: string,
  payload: unknown,
): Promise<Result<{ seq: number }>> {
  if (!(await lockRun(exec, runId))) return fail('NOT_FOUND', `run ${runId} 不存在`);

  const seq = await insertEvent(exec, runId, type, payload);
  if (seq === null) return fail('STORAGE_FAILED', '写入运行事件失败');
  return ok({ seq });
}

/**
 * Append one event to a run's log. Pass `tx` to join the caller's transaction;
 * otherwise the insert runs in its own so `seq` is assigned atomically.
 */
export async function appendEvent(
  runId: number,
  type: string,
  payload: unknown = {},
  tx?: Pick<Database, 'execute'>,
): Promise<Result<{ seq: number }>> {
  try {
    if (tx) return await appendWith(tx, runId, type, payload);
    return await db.transaction((inner) => appendWith(inner, runId, type, payload));
  } catch (error) {
    return storageFailure('写入运行事件', error);
  }
}

/**
 * Create a run for a thread and record the user's pitch. Everything happens in
 * one transaction: a run without its message or `run.created` event would leave
 * the chat page unable to render the turn. The chain is snapshotted first
 * (outside the transaction so a slow settings read never holds the row locks);
 * a missing chain is not fatal — `{}` records "nothing configured".
 */
export async function createRun(input: CreateRunInput): Promise<Result<CreateRunResult>> {
  const parsed = createRunInputSchema.safeParse(input);
  if (!parsed.success) return fail('VALIDATION_FAILED', formatIssues(parsed.error));

  const { threadId: requestedThreadId, idea, angles } = parsed.data;

  const chain = await getChain('quality');
  const chainSnapshot: unknown = chain.ok ? chain.value : {};

  try {
    const created = await db.transaction(async (tx) => {
      const found = await tx
        .select({ ideaId: threads.ideaId })
        .from(threads)
        .where(eq(threads.id, requestedThreadId))
        .limit(1);

      let threadId = requestedThreadId;
      let ideaId: number;

      if (found.length > 0) {
        ideaId = firstRow(found).ideaId;

        // A thread opened before any pitch existed holds an empty idea row;
        // the first real pitch fills that placeholder instead of being lost.
        const current = firstRow(
          await tx
            .select({ rawInput: ideas.rawInput })
            .from(ideas)
            .where(eq(ideas.id, ideaId))
            .limit(1),
        );
        if (current.rawInput.trim() === '') {
          await tx.update(ideas).set({ rawInput: idea }).where(eq(ideas.id, ideaId));
        }
      } else {
        const title = idea.replace(/\s+/g, ' ').trim().slice(0, 60);
        const ideaRow = firstRow(
          await tx.insert(ideas).values({ title, rawInput: idea }).returning({ id: ideas.id }),
        );
        const threadRow = firstRow(
          await tx
            .insert(threads)
            .values({ ideaId: ideaRow.id, title })
            .returning({ id: threads.id }),
        );
        ideaId = ideaRow.id;
        threadId = threadRow.id;
      }

      const runRow = firstRow(
        await tx
          .insert(runs)
          .values({
            ideaId,
            threadId,
            status: 'queued',
            stage: 'S0',
            deadlineAt: sql`now() + interval '${sql.raw(String(RUN_DEADLINE_MINUTES))} minutes'`,
            chainSnapshot,
          })
          .returning({ id: runs.id }),
      );

      await tx.insert(messages).values({
        threadId,
        role: 'user',
        parts: [{ type: 'text', text: idea }],
      });

      const appended = await appendEvent(
        runRow.id,
        'run.created',
        { idea, angles: angles ?? [] },
        tx,
      );
      if (!appended.ok) throw new EventWriteError(appended);

      return { runId: runRow.id, threadId };
    });

    return ok(created);
  } catch (error) {
    if (error instanceof EventWriteError) return error.failure;
    return storageFailure('创建 run', error);
  }
}

export type RunEventRecord = {
  id: number;
  seq: number;
  type: string;
  payload: unknown;
  createdAt: Date;
};

/**
 * Events after `afterSeq`, oldest first. The page size bounds one poll; the
 * client resumes from its last seen seq, so nothing is lost when more arrive.
 */
export async function readEvents(
  runId: number,
  afterSeq: number,
): Promise<Result<RunEventRecord[]>> {
  const after = Number.isSafeInteger(afterSeq) && afterSeq > 0 ? afterSeq : 0;

  try {
    const rows = await db
      .select({
        id: runEvents.id,
        seq: runEvents.seq,
        type: runEvents.type,
        payload: runEvents.payload,
        createdAt: runEvents.createdAt,
      })
      .from(runEvents)
      .where(and(eq(runEvents.runId, runId), gt(runEvents.seq, after)))
      .orderBy(asc(runEvents.seq))
      .limit(EVENT_PAGE_SIZE);

    return ok(rows);
  } catch (error) {
    return storageFailure('读取运行事件', error);
  }
}

export type RunRecord = {
  id: number;
  ideaId: number;
  threadId: number | null;
  status: string;
  stage: string | null;
  deadlineAt: Date | null;
  createdAt: Date;
};

export async function getRun(runId: number): Promise<Result<RunRecord | null>> {
  if (!Number.isInteger(runId) || runId <= 0) return fail('NOT_FOUND', `run ${runId} 不存在`);

  try {
    const rows = await db
      .select({
        id: runs.id,
        ideaId: runs.ideaId,
        threadId: runs.threadId,
        status: runs.status,
        stage: runs.stage,
        deadlineAt: runs.deadlineAt,
        createdAt: runs.createdAt,
      })
      .from(runs)
      .where(eq(runs.id, runId))
      .limit(1);

    return ok(rows[0] ?? null);
  } catch (error) {
    return storageFailure('读取 run', error);
  }
}

/** What a worker needs to start a stage: the pitch and the run's deadline. */
export type RunContextRecord = {
  id: number;
  idea: string;
  status: string;
  stage: string | null;
  deadlineAt: Date | null;
};

/**
 * Join the run with its idea, so a worker never has to guess which `ideas.raw_input`
 * belongs to the run it picked up.
 */
export async function getRunContext(runId: number): Promise<Result<RunContextRecord | null>> {
  if (!Number.isInteger(runId) || runId <= 0) return fail('NOT_FOUND', `run ${runId} 不存在`);

  try {
    const rows = await db
      .select({
        id: runs.id,
        idea: ideas.rawInput,
        status: runs.status,
        stage: runs.stage,
        deadlineAt: runs.deadlineAt,
      })
      .from(runs)
      .innerJoin(ideas, eq(runs.ideaId, ideas.id))
      .where(eq(runs.id, runId))
      .limit(1);

    return ok(rows[0] ?? null);
  } catch (error) {
    return storageFailure('读取 run 上下文', error);
  }
}

export type ThreadRecord = {
  id: number;
  ideaId: number;
  title: string;
  createdAt: Date;
};

/**
 * The newest run of a thread, which is what the chat page's rail follows.
 * `createdAt` alone is not a stable order (two runs can share a timestamp), so
 * `id` breaks the tie.
 */
export async function getLatestRunForThread(threadId: number): Promise<Result<RunRecord | null>> {
  if (!Number.isInteger(threadId) || threadId <= 0)
    return fail('NOT_FOUND', `thread ${threadId} 不存在`);

  try {
    const rows = await db
      .select({
        id: runs.id,
        ideaId: runs.ideaId,
        threadId: runs.threadId,
        status: runs.status,
        stage: runs.stage,
        deadlineAt: runs.deadlineAt,
        createdAt: runs.createdAt,
      })
      .from(runs)
      .where(eq(runs.threadId, threadId))
      .orderBy(desc(runs.createdAt), desc(runs.id))
      .limit(1);

    return ok(rows[0] ?? null);
  } catch (error) {
    return storageFailure('读取 run', error);
  }
}

export async function getThread(threadId: number): Promise<Result<ThreadRecord | null>> {
  if (!Number.isInteger(threadId) || threadId <= 0)
    return fail('NOT_FOUND', `thread ${threadId} 不存在`);

  try {
    const rows = await db
      .select({
        id: threads.id,
        ideaId: threads.ideaId,
        title: threads.title,
        createdAt: threads.createdAt,
      })
      .from(threads)
      .where(eq(threads.id, threadId))
      .limit(1);

    return ok(rows[0] ?? null);
  } catch (error) {
    return storageFailure('读取会话', error);
  }
}

export type MessageRecord = {
  id: number;
  threadId: number;
  role: string;
  parts: unknown;
  createdAt: Date;
};

/** Oldest first, with `id` as a tie-break for turns in the same millisecond. */
export async function getMessages(threadId: number): Promise<Result<MessageRecord[]>> {
  try {
    const rows = await db
      .select({
        id: messages.id,
        threadId: messages.threadId,
        role: messages.role,
        parts: messages.parts,
        createdAt: messages.createdAt,
      })
      .from(messages)
      .where(eq(messages.threadId, threadId))
      .orderBy(asc(messages.createdAt), asc(messages.id));

    return ok(rows);
  } catch (error) {
    return storageFailure('读取消息', error);
  }
}

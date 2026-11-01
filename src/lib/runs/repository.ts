import { and, asc, desc, eq, gt, sql } from 'drizzle-orm';
import { z } from 'zod';

import { db, type Database } from '@/lib/db/client';
import { ideas, messages, reports, runEvents, runs, threads } from '@/lib/db/schema';
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

export type DeleteThreadResult = { threadId: number; ideaDeleted: boolean };

/**
 * Deletes one conversation. The thread's messages cascade; its idea is removed
 * only when no other thread points at it, which cascades that idea's runs and
 * run events. A run whose idea survives (a shared idea) keeps its row with
 * `thread_id` set to null, as the schema intends.
 */
export async function deleteThread(threadId: number): Promise<Result<DeleteThreadResult>> {
  if (!Number.isInteger(threadId) || threadId <= 0)
    return fail('VALIDATION_FAILED', 'threadId 必须是正整数');

  try {
    const result = await db.transaction(async (tx): Promise<DeleteThreadResult | null> => {
      const rows = await tx
        .select({ id: threads.id, ideaId: threads.ideaId })
        .from(threads)
        .where(eq(threads.id, threadId))
        .for('update');
      const thread = rows[0];
      if (!thread) return null;

      await tx.delete(threads).where(eq(threads.id, threadId));

      const remaining = await tx
        .select({ id: threads.id })
        .from(threads)
        .where(eq(threads.ideaId, thread.ideaId))
        .limit(1);
      const ideaDeleted = remaining.length === 0;
      if (ideaDeleted) await tx.delete(ideas).where(eq(ideas.id, thread.ideaId));

      return { threadId, ideaDeleted };
    });

    return result === null ? fail('NOT_FOUND', `会话 ${threadId} 不存在`) : ok(result);
  } catch (error) {
    return storageFailure('删除会话', error);
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

/** The chain is snapshotted outside the transaction so a slow read holds no locks. */
async function qualityChainSnapshot(): Promise<unknown> {
  const chain = await getChain('quality');
  return chain.ok ? chain.value : {};
}

/** Drizzle's transaction handle exposes the same writes as the database. */
type WriteExecutor = Pick<Database, 'insert' | 'execute'>;

/**
 * The rows every research start needs: a queued run, the pitch as the first
 * user message, and `run.created`. `createRun` (existing thread) and
 * `createResearch` (idea + thread + run) share this so both leave the chat page
 * in a renderable state.
 */
async function insertRunWithPitch(
  tx: WriteExecutor,
  input: {
    ideaId: number;
    threadId: number;
    idea: string;
    angles?: string[] | undefined;
    chainSnapshot: unknown;
    /** Reruns reuse the thread's existing pitch instead of adding a turn. */
    recordMessage?: boolean;
  },
): Promise<number> {
  const runRow = firstRow(
    await tx
      .insert(runs)
      .values({
        ideaId: input.ideaId,
        threadId: input.threadId,
        status: 'queued',
        stage: 'S0',
        deadlineAt: sql`now() + interval '${sql.raw(String(RUN_DEADLINE_MINUTES))} minutes'`,
        chainSnapshot: input.chainSnapshot,
      })
      .returning({ id: runs.id }),
  );

  if (input.recordMessage !== false) {
    await tx.insert(messages).values({
      threadId: input.threadId,
      role: 'user',
      parts: [{ type: 'text', text: input.idea }],
    });
  }

  const appended = await appendEvent(
    runRow.id,
    'run.created',
    { idea: input.idea, angles: input.angles ?? [] },
    tx,
  );
  if (!appended.ok) throw new EventWriteError(appended);

  return runRow.id;
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

  const chainSnapshot = await qualityChainSnapshot();

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

      const runId = await insertRunWithPitch(tx, {
        ideaId,
        threadId,
        idea,
        angles,
        chainSnapshot,
      });

      return { runId, threadId };
    });

    return ok(created);
  } catch (error) {
    if (error instanceof EventWriteError) return error.failure;
    return storageFailure('创建 run', error);
  }
}

/** Persists a chat turn the user typed after the thread was created. */
export async function appendUserMessage(
  threadId: number,
  text: string,
): Promise<Result<{ id: number }>> {
  if (!Number.isInteger(threadId) || threadId <= 0)
    return fail('VALIDATION_FAILED', 'threadId 必须是正整数');
  const body = text.trim();
  if (body === '') return fail('VALIDATION_FAILED', '消息不能为空');

  try {
    const rows = await db
      .insert(messages)
      .values({ threadId, role: 'user', parts: [{ type: 'text', text: body }] })
      .returning({ id: messages.id });
    return ok(firstRow(rows));
  } catch (error) {
    return storageFailure('保存消息', error);
  }
}

export type RerunResult = { runId: number; threadId: number };

/**
 * Starts a fresh run for an existing conversation, reusing its pitch. Unlike
 * `createRun`, no user message is written: the rerun was requested in chat, and
 * adding the pitch again would print a duplicate turn. The run still gets its
 * `run.created` event so the SSE rail paints immediately.
 */
export async function createRerun(
  threadId: number,
  focus?: string,
): Promise<Result<RerunResult>> {
  if (!Number.isInteger(threadId) || threadId <= 0)
    return fail('VALIDATION_FAILED', 'threadId 必须是正整数');

  const chainSnapshot = await qualityChainSnapshot();

  try {
    const created = await db.transaction(async (tx): Promise<RerunResult | null> => {
      const rows = await tx
        .select({ ideaId: threads.ideaId, title: threads.title, rawInput: ideas.rawInput })
        .from(threads)
        .innerJoin(ideas, eq(ideas.id, threads.ideaId))
        .where(eq(threads.id, threadId))
        .limit(1);
      const thread = rows[0];
      if (thread === undefined) return null;

      const base = thread.rawInput.trim() === '' ? thread.title : thread.rawInput;
      const trimmedFocus = focus?.trim() ?? '';
      const idea =
        trimmedFocus === '' ? base : `${base}\n\n本次调整方向：${trimmedFocus.slice(0, 500)}`;
      const runId = await insertRunWithPitch(tx, {
        ideaId: thread.ideaId,
        threadId,
        idea,
        chainSnapshot,
        recordMessage: false,
      });
      return { runId, threadId };
    });

    return created === null ? fail('NOT_FOUND', `会话 ${threadId} 不存在`) : ok(created);
  } catch (error) {
    if (error instanceof EventWriteError) return error.failure;
    return storageFailure('重新发起研究', error);
  }
}

export const createResearchInputSchema = z.strictObject({
  idea: z.string().trim().min(8, '想法至少 8 个字符').max(4000, '想法最多 4000 个字符'),
});

export type CreateResearchInput = z.input<typeof createResearchInputSchema>;

export type CreateResearchResult = { ideaId: number; threadId: number; runId: number };

/**
 * The first screen's "start research": idea, thread, first user message and run
 * are one transaction, so a partial write can never leave a conversation with
 * nothing to follow. The queue is separate — `startResearchAction` enqueues
 * after the commit, exactly like `createRunAction`.
 */
export async function createResearch(
  input: CreateResearchInput,
): Promise<Result<CreateResearchResult>> {
  const parsed = createResearchInputSchema.safeParse(input);
  if (!parsed.success) return fail('VALIDATION_FAILED', formatIssues(parsed.error));

  const { idea } = parsed.data;
  const chainSnapshot = await qualityChainSnapshot();
  const title = idea.replace(/\s+/g, ' ').trim().slice(0, 60);

  try {
    const created = await db.transaction(async (tx) => {
      const ideaRow = firstRow(
        await tx.insert(ideas).values({ title, rawInput: idea }).returning({ id: ideas.id }),
      );
      const threadRow = firstRow(
        await tx
          .insert(threads)
          .values({ ideaId: ideaRow.id, title })
          .returning({ id: threads.id }),
      );

      const runId = await insertRunWithPitch(tx, {
        ideaId: ideaRow.id,
        threadId: threadRow.id,
        idea,
        chainSnapshot,
      });

      return { ideaId: ideaRow.id, threadId: threadRow.id, runId };
    });

    return ok(created);
  } catch (error) {
    if (error instanceof EventWriteError) return error.failure;
    return storageFailure('创建研究', error);
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

/**
 * The newest page of a run's log, oldest first. The monitor page starts from
 * the tail so its first paint shows the latest stage and failures; the SSE
 * cursor then continues from the last seq without replaying history.
 */
export async function readRecentEvents(
  runId: number,
  limit = EVENT_PAGE_SIZE,
): Promise<Result<RunEventRecord[]>> {
  if (!Number.isInteger(runId) || runId <= 0) return fail('NOT_FOUND', `run ${runId} 不存在`);
  const capped =
    Number.isInteger(limit) && limit > 0 ? Math.min(limit, EVENT_PAGE_SIZE) : EVENT_PAGE_SIZE;

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
      .where(eq(runEvents.runId, runId))
      .orderBy(desc(runEvents.seq))
      .limit(capped);

    return ok([...rows].reverse());
  } catch (error) {
    return storageFailure('读取运行事件', error);
  }
}

/** Statuses a run may be moved into by a worker. */
const RUN_STATUSES: readonly string[] = [
  'queued',
  'running',
  'paused',
  'finished',
  'failed',
  'cancelled',
];

/**
 * The subset of `runs` a worker owns. `error` is the structured failure; pass
 * `null` to clear it when a failed run is retried. Every field is optional so
 * one call can move a run without touching the rest of its row.
 */
export type RunStatePatch = {
  status?: string;
  stage?: string | null;
  startedAt?: Date;
  finishedAt?: Date | null;
  deadlineAt?: Date | null;
  error?: unknown;
};

/**
 * Write a run's own state. The event log drives SSE, but `runs.status` is what
 * the stream route reads to decide a run is over, so a stage that only appends
 * events would leave the connection open forever.
 */
export async function setRunState(runId: number, patch: RunStatePatch): Promise<Result<void>> {
  if (!Number.isInteger(runId) || runId <= 0) return fail('NOT_FOUND', `run ${runId} 不存在`);
  if (patch.status !== undefined && !RUN_STATUSES.includes(patch.status)) {
    return fail('VALIDATION_FAILED', `未知的运行状态：${patch.status}`);
  }

  const values: Record<string, unknown> = {};
  if (patch.status !== undefined) values.status = patch.status;
  if (patch.stage !== undefined) values.stage = patch.stage;
  if (patch.startedAt !== undefined) values.startedAt = patch.startedAt;
  if (patch.finishedAt !== undefined) values.finishedAt = patch.finishedAt;
  if (patch.deadlineAt !== undefined) values.deadlineAt = patch.deadlineAt;
  if (patch.error !== undefined) {
    // `null` must clear the column, not store the JSON value `null`.
    values.error = patch.error === null ? null : sql`${JSON.stringify(patch.error)}::jsonb`;
  }

  if (Object.keys(values).length === 0) return ok(undefined);

  try {
    const rows = await db
      .update(runs)
      .set(values)
      .where(eq(runs.id, runId))
      .returning({ id: runs.id });

    if (rows.length === 0) return fail('NOT_FOUND', `run ${runId} 不存在`);
    return ok(undefined);
  } catch (error) {
    return storageFailure('更新 run 状态', error);
  }
}

export type RunRecord = {
  id: number;
  ideaId: number;
  threadId: number | null;
  status: string;
  stage: string | null;
  deadlineAt: Date | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  /** Structured failure written by the worker; `null` until a run fails. */
  error: unknown;
  createdAt: Date;
};

/** Every run of one conversation, oldest first; chat renders one card each. */
export async function listRunsForThread(threadId: number): Promise<Result<RunRecord[]>> {
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
        startedAt: runs.startedAt,
        finishedAt: runs.finishedAt,
        error: runs.error,
        createdAt: runs.createdAt,
      })
      .from(runs)
      .where(eq(runs.threadId, threadId))
      .orderBy(asc(runs.createdAt), asc(runs.id));
    return ok(rows);
  } catch (error) {
    return storageFailure('读取会话的研究记录', error);
  }
}

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
        startedAt: runs.startedAt,
        finishedAt: runs.finishedAt,
        error: runs.error,
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

/** Newest runs first, for the workbench table and the `/runs` index. */
export type RunSummaryRecord = {
  id: number;
  ideaTitle: string;
  status: string;
  stage: string | null;
  hasReport: boolean;
  /** 0–100 rubric total from the published report; `null` before S5. */
  rubricTotal: number | null;
  credibilityGrade: string | null;
  /** The report's final decision (one of the five), in Chinese; `null` before S5. */
  decision: string | null;
  /** Last meaningful moment: finish, start, or creation when neither happened. */
  updatedAt: Date;
};

const RUN_LIST_LIMIT = 50;
const RUN_LIST_MAX = 200;

/**
 * The most recent runs with the bits both index pages show. `reports` is LEFT
 * JOINed (it is unique per run) so "does this run have a report?" costs no
 * second query per row.
 */
export async function listRuns(limit = RUN_LIST_LIMIT): Promise<Result<RunSummaryRecord[]>> {
  const capped =
    Number.isInteger(limit) && limit > 0 ? Math.min(limit, RUN_LIST_MAX) : RUN_LIST_LIMIT;

  try {
    const rows = await db
      .select({
        id: runs.id,
        ideaTitle: ideas.title,
        status: runs.status,
        stage: runs.stage,
        reportId: reports.id,
        rubricTotal: reports.rubricTotal,
        credibilityGrade: reports.credibilityGrade,
        decision: reports.decision,
        finishedAt: runs.finishedAt,
        startedAt: runs.startedAt,
        createdAt: runs.createdAt,
      })
      .from(runs)
      .innerJoin(ideas, eq(runs.ideaId, ideas.id))
      .leftJoin(reports, eq(reports.runId, runs.id))
      .orderBy(desc(runs.createdAt), desc(runs.id))
      .limit(capped);

    return ok(
      rows.map(({ reportId, finishedAt, startedAt, createdAt, ...row }) => ({
        ...row,
        hasReport: reportId !== null,
        updatedAt: finishedAt ?? startedAt ?? createdAt,
      })),
    );
  } catch (error) {
    return storageFailure('读取运行列表', error);
  }
}

/**
 * Every `runs.status` the worker can write, plus the state of a conversation
 * that has never been run. A value outside this set (a hand-edited row) is
 * passed through verbatim rather than guessed into a neighbouring state.
 */
export type ThreadSummaryStatus =
  'not_started' | 'queued' | 'running' | 'paused' | 'finished' | 'failed' | 'cancelled';

/** One row of the sidebar: a conversation and the newest run behind it. */
export type ThreadSummaryRecord = {
  id: number;
  title: string;
  /** Newest activity: the run's end/start/creation, or the thread's creation. */
  updatedAt: Date;
  /** `not_started` when the conversation has no run at all. */
  status: ThreadSummaryStatus;
  /** Pipeline stage of that run (`S1`…`S6`); `null` before the worker starts. */
  stage: string | null;
  /** 0–100 rubric total from the published report; `null` before S5. */
  score: number | null;
  /** Credibility grade (A–D) from the published report; `null` before S5. */
  grade: string | null;
  /** The report's final decision, in Chinese; `null` before S5. */
  decision: string | null;
  hasReport: boolean;
};

const THREAD_LIST_LIMIT = 50;
const THREAD_LIST_MAX = 200;

/** `null` means "no run yet"; anything else is surfaced as stored. */
function threadStatus(raw: string | null): ThreadSummaryStatus {
  if (raw === null) return 'not_started';
  // A value outside `RUN_STATUSES` reaches the UI verbatim instead of being
  // folded into a state the run is not in.
  return raw as ThreadSummaryStatus;
}

/**
 * The newest conversations with the one run each one follows. A LATERAL join
 * picks that run inside the same statement as the list, so "does this
 * conversation have a report?" and "what score did it get?" cost no per-row
 * query. A conversation without a run is still listed, as `not_started`.
 */
export async function listThreadSummaries(
  limit = THREAD_LIST_LIMIT,
): Promise<Result<ThreadSummaryRecord[]>> {
  const capped =
    Number.isInteger(limit) && limit > 0 ? Math.min(limit, THREAD_LIST_MAX) : THREAD_LIST_LIMIT;

  const latestRun = db
    .select({
      status: runs.status,
      stage: runs.stage,
      startedAt: runs.startedAt,
      finishedAt: runs.finishedAt,
      createdAt: runs.createdAt,
      reportId: reports.id,
      rubricTotal: reports.rubricTotal,
      credibilityGrade: reports.credibilityGrade,
      decision: reports.decision,
    })
    .from(runs)
    .leftJoin(reports, eq(reports.runId, runs.id))
    .where(eq(runs.threadId, threads.id))
    .orderBy(desc(runs.createdAt), desc(runs.id))
    .limit(1)
    .as('latest_run');

  try {
    const rows = await db
      .select({
        id: threads.id,
        title: threads.title,
        threadCreatedAt: threads.createdAt,
        status: latestRun.status,
        stage: latestRun.stage,
        startedAt: latestRun.startedAt,
        finishedAt: latestRun.finishedAt,
        runCreatedAt: latestRun.createdAt,
        reportId: latestRun.reportId,
        score: latestRun.rubricTotal,
        grade: latestRun.credibilityGrade,
        decision: latestRun.decision,
      })
      .from(threads)
      .leftJoinLateral(latestRun, sql`true`)
      .orderBy(
        desc(
          sql`coalesce(${latestRun.finishedAt}, ${latestRun.startedAt}, ${latestRun.createdAt}, ${threads.createdAt})`,
        ),
        desc(threads.id),
      )
      .limit(capped);

    return ok(
      rows.map(
        ({ reportId, status, threadCreatedAt, startedAt, finishedAt, runCreatedAt, ...row }) => ({
          ...row,
          status: threadStatus(status),
          hasReport: reportId !== null,
          // A report that does not exist has no score; never borrow a neighbour's.
          updatedAt: finishedAt ?? startedAt ?? runCreatedAt ?? threadCreatedAt,
        }),
      ),
    );
  } catch (error) {
    return storageFailure('读取会话列表', error);
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
        startedAt: runs.startedAt,
        finishedAt: runs.finishedAt,
        error: runs.error,
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

/** Rows created by the old two-step form kept an empty pitch; they are not ideas. */
const RECENT_IDEA_LIMIT = 5;

/**
 * Titles of the newest real pitches, newest first. The new-research screen
 * offers them as suggestion chips, so placeholders (`raw_input` empty) are
 * filtered out instead of surfacing "新研究" as a direction.
 */
export async function listRecentIdeaTitles(limit = RECENT_IDEA_LIMIT): Promise<Result<string[]>> {
  const safeLimit =
    Number.isSafeInteger(limit) && limit > 0
      ? Math.min(limit, RECENT_IDEA_LIMIT * 4)
      : RECENT_IDEA_LIMIT;

  try {
    const rows = await db
      .select({ title: ideas.title })
      .from(ideas)
      .where(sql`btrim(${ideas.rawInput}) <> ''`)
      .orderBy(desc(ideas.createdAt), desc(ideas.id))
      .limit(safeLimit);

    return ok(rows.map((row) => row.title));
  } catch (error) {
    return storageFailure('读取最近想法', error);
  }
}

/**
 * The two parts a conversation keeps after a reload: what the assistant said
 * and how it got there. Tool calls and data parts are re-created per request, so
 * persisting them would only store a stale UI fragment.
 */
export type AssistantOption = {
  id: string;
  label: string;
  description?: string | undefined;
};

/** What the chat persists: prose, thinking, and the option panel. */
export type AssistantMessagePart =
  | { type: 'text' | 'reasoning'; text: string }
  | { type: 'tool-present_options'; options: AssistantOption[] };

export type AppendAssistantMessageResult = { inserted: boolean; id: number };

/** Whether the thread already holds an assistant turn, i.e. a saved answer. */
export async function hasAssistantMessage(threadId: number): Promise<Result<boolean>> {
  if (!Number.isInteger(threadId) || threadId <= 0)
    return fail('NOT_FOUND', `thread ${threadId} 不存在`);

  try {
    const rows = await db
      .select({ id: messages.id })
      .from(messages)
      .where(and(eq(messages.threadId, threadId), eq(messages.role, 'assistant')))
      .limit(1);

    return ok(rows.length > 0);
  } catch (error) {
    return storageFailure('读取消息', error);
  }
}

/**
 * Save the assistant's answer for a thread, at most once.
 *
 * The client calls this from `onFinish`, and a reloaded page may call it again
 * for the same turn, so "second writer loses" is the contract: the thread row is
 * locked, the existing assistant turn is read under that lock, and only a thread
 * without one gets an insert. The lock is what makes check-then-insert atomic;
 * no unique index is needed (and one on `role` would forbid a second turn).
 */
/** JSONB normalises key order, so compare the two fields that are stored. */
function sameAssistantParts(
  stored: unknown,
  incoming: readonly AssistantMessagePart[],
): boolean {
  if (!Array.isArray(stored) || stored.length !== incoming.length) return false;
  return incoming.every((part, index) => {
    const row = stored[index];
    if (typeof row !== 'object' || row === null) return false;
    const record = row as { type?: unknown; text?: unknown; options?: unknown };

    if (part.type === 'tool-present_options') {
      return record.type === part.type && JSON.stringify(record.options) === JSON.stringify(part.options);
    }
    return record.type === part.type && record.text === part.text;
  });
}

export async function appendAssistantMessage(
  threadId: number,
  parts: readonly AssistantMessagePart[],
): Promise<Result<AppendAssistantMessageResult>> {
  if (!Number.isInteger(threadId) || threadId <= 0)
    return fail('NOT_FOUND', `thread ${threadId} 不存在`);
  if (parts.length === 0) return fail('VALIDATION_FAILED', '回复内容不能为空');

  try {
    const stored = await db.transaction(async (tx) => {
      const locked = await tx.execute<{ id: number }>(
        sql`select id from threads where id = ${threadId} for update`,
      );
      if (locked.length === 0) return null;

      // Every assistant turn is kept, not just the first. Only an identical
      // retry of the latest answer is skipped, so a duplicated `onFinish`
      // cannot write the same reply twice.
      const existing = await tx
        .select({ id: messages.id, parts: messages.parts })
        .from(messages)
        .where(and(eq(messages.threadId, threadId), eq(messages.role, 'assistant')))
        .orderBy(desc(messages.id))
        .limit(1);

      const first = existing[0];
      if (first !== undefined && sameAssistantParts(first.parts, parts)) {
        return { inserted: false, id: first.id };
      }

      const row = firstRow(
        await tx
          .insert(messages)
          .values({ threadId, role: 'assistant', parts })
          .returning({ id: messages.id }),
      );
      return { inserted: true, id: row.id };
    });

    if (stored === null) return fail('NOT_FOUND', `thread ${threadId} 不存在`);
    return ok(stored);
  } catch (error) {
    return storageFailure('保存助手回复', error);
  }
}

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

import { asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';

import { db } from '@/lib/db/client';
import { validationTasks } from '@/lib/db/schema';

import { DEFAULT_PLAN } from './template';

export type ValidationErrorCode = 'VALIDATION_FAILED' | 'NOT_FOUND' | 'STORAGE_FAILED';

export type ValidationError = { code: ValidationErrorCode; message: string };

/** A failure that crosses a layer boundary without throwing. */
export type ValidationResult<T> = { ok: true; value: T } | ({ ok: false } & ValidationError);

export interface ValidationTaskRecord {
  id: number;
  runId: number;
  day: number;
  title: string;
  done: boolean;
  evidenceId: number | null;
  note: string | null;
  createdAt: Date;
}

function ok<T>(value: T): ValidationResult<T> {
  return { ok: true, value };
}

function fail<T>(code: ValidationErrorCode, message: string): ValidationResult<T> {
  return { ok: false, code, message };
}

/** SQLSTATE only: postgres.js errors also carry query text and parameters. */
function storageFailure<T>(action: string, error: unknown): ValidationResult<T> {
  const state = (error as { code?: unknown } | null)?.code;
  const detail = typeof state === 'string' ? ` (SQLSTATE ${state})` : '';
  return fail('STORAGE_FAILED', `${action}失败${detail}`);
}

const runIdSchema = z.number().int('runId 必须是整数').positive('runId 必须为正数');

const toggleInputSchema = z.object({
  id: z.number().int('任务 id 必须是整数').positive('任务 id 必须为正数'),
  done: z.boolean(),
});

const taskColumns = {
  id: validationTasks.id,
  runId: validationTasks.runId,
  day: validationTasks.day,
  title: validationTasks.title,
  done: validationTasks.done,
  evidenceId: validationTasks.evidenceId,
  note: validationTasks.note,
  createdAt: validationTasks.createdAt,
};

/** `done` is nullable in the schema default; the API only exposes a boolean. */
function toRecord(row: {
  id: number;
  runId: number;
  day: number;
  title: string;
  done: boolean | null;
  evidenceId: number | null;
  note: string | null;
  createdAt: Date;
}): ValidationTaskRecord {
  return { ...row, done: row.done === true };
}

/** The run's tasks, oldest day first. An empty plan is a valid answer. */
export async function listPlan(runId: number): Promise<ValidationResult<ValidationTaskRecord[]>> {
  const parsed = runIdSchema.safeParse(runId);
  if (!parsed.success) return fail('NOT_FOUND', `run ${String(runId)} 不存在`);

  try {
    const rows = await db
      .select(taskColumns)
      .from(validationTasks)
      .where(eq(validationTasks.runId, parsed.data))
      .orderBy(asc(validationTasks.day), asc(validationTasks.id));

    return ok(rows.map(toRecord));
  } catch (error) {
    return storageFailure('读取验证计划', error);
  }
}

/**
 * Materialise the 14-day template for a run that has none. The run row is
 * locked first so two concurrent page loads cannot both insert a plan; the
 * second one waits, then sees the rows the first wrote.
 */
export async function ensurePlan(runId: number): Promise<ValidationResult<ValidationTaskRecord[]>> {
  const parsed = runIdSchema.safeParse(runId);
  if (!parsed.success) return fail('NOT_FOUND', `run ${String(runId)} 不存在`);

  try {
    return await db.transaction(async (tx) => {
      const locked = await tx.execute<{ id: number }>(
        sql`select id from runs where id = ${parsed.data} for update`,
      );
      if (locked.length === 0) return fail('NOT_FOUND', `run ${parsed.data} 不存在`);

      const existing = await tx
        .select(taskColumns)
        .from(validationTasks)
        .where(eq(validationTasks.runId, parsed.data))
        .orderBy(asc(validationTasks.day), asc(validationTasks.id));
      if (existing.length > 0) return ok(existing.map(toRecord));

      const inserted = await tx
        .insert(validationTasks)
        .values(
          DEFAULT_PLAN.map((item) => ({
            runId: parsed.data,
            day: item.day,
            title: item.title,
          })),
        )
        .returning(taskColumns);

      const ordered = [...inserted].sort((left, right) => left.day - right.day);
      return ok(ordered.map(toRecord));
    });
  } catch (error) {
    return storageFailure('初始化验证计划', error);
  }
}

/**
 * Check or uncheck one task. Returns the stored row so the caller can
 * revalidate the run's page without a second read.
 */
export async function toggleTask(
  rawId: unknown,
  rawDone: unknown,
): Promise<ValidationResult<ValidationTaskRecord>> {
  const parsed = toggleInputSchema.safeParse({ id: rawId, done: rawDone });
  if (!parsed.success) {
    return fail(
      'VALIDATION_FAILED',
      parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; '),
    );
  }

  try {
    const rows = await db
      .update(validationTasks)
      .set({ done: parsed.data.done })
      .where(eq(validationTasks.id, parsed.data.id))
      .returning(taskColumns);

    const row = rows[0];
    if (!row) return fail('NOT_FOUND', `验证任务 ${parsed.data.id} 不存在`);
    return ok(toRecord(row));
  } catch (error) {
    return storageFailure('更新验证任务', error);
  }
}

import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';

import { db } from '@/lib/db/client';
import { settings } from '@/lib/db/schema';

// The schema is pure data and lives in its own module so client components can
// validate the form without importing the database client. Re-exported here so
// server-side callers need only this module.
export * from './crawl-settings';

export type SettingsErrorCode = 'VALIDATION_FAILED' | 'STORAGE_FAILED';

export type SettingsError = { code: SettingsErrorCode; message: string };

/** A failure that crosses a layer boundary without throwing. */
export type Result<T> = { ok: true; value: T } | ({ ok: false } & SettingsError);

function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

function fail<T>(code: SettingsErrorCode, message: string): Result<T> {
  return { ok: false, code, message };
}

/** SQLSTATE only: postgres.js errors also carry query text and parameters. */
function storageFailure<T>(action: string, error: unknown): Result<T> {
  const state = (error as { code?: unknown } | null)?.code;
  const detail = typeof state === 'string' ? ` (SQLSTATE ${state})` : '';
  return fail('STORAGE_FAILED', `${action}失败${detail}`);
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.length > 0 ? issue.path.join('.') : '(root)'}: ${issue.message}`)
    .join('; ');
}

/**
 * Crawl politeness and volume. Every field has a default, so a partial or
 * missing row still yields a usable configuration; values outside the ranges
 * are rejected rather than clamped, because silently replacing an operator's
 * 90-second delay with 8 seconds would hide a mistake.
 */
export const crawlSettingsSchema = z
  .strictObject({
    /** Browser tier off means static-only collection; it never disables search. */
    enabled: z.boolean().default(true),
    respectRobots: z.boolean().default(true),
    /** S1 crawls serially, so this is stored for a future pool, not enforced yet. */
    perHostConcurrency: z
      .number()
      .int('每主机并发必须是整数')
      .min(1, '每主机并发不能小于 1')
      .max(3, '每主机并发不能大于 3')
      .default(1),
    minDelayMs: z
      .number()
      .int('最小间隔必须是整数')
      .min(1000, '最小间隔不能小于 1000ms')
      .max(30000, '最小间隔不能大于 30000ms')
      .default(3000),
    maxDelayMs: z
      .number()
      .int('最大间隔必须是整数')
      .min(1000, '最大间隔不能小于 1000ms')
      .max(60000, '最大间隔不能大于 60000ms')
      .default(8000),
    maxPagesPerRun: z
      .number()
      .int('单次页数必须是整数')
      .min(10, '单次页数不能小于 10')
      .max(200, '单次页数不能大于 200')
      .default(120),
    deadlineMinutes: z
      .number()
      .int('超时分钟必须是整数')
      .min(10, '超时不能小于 10 分钟')
      .max(180, '超时不能大于 180 分钟')
      .default(90),
  })
  .superRefine((value, ctx) => {
    if (value.minDelayMs > value.maxDelayMs) {
      ctx.addIssue({
        code: 'custom',
        path: ['maxDelayMs'],
        message: '最大间隔不能小于最小间隔',
      });
    }
  });

export type CrawlSettings = z.output<typeof crawlSettingsSchema>;

/** What the worker and the page use when no row exists yet. */
export const DEFAULT_CRAWL_SETTINGS: CrawlSettings = crawlSettingsSchema.parse({});

/**
 * One delay for the whole run, drawn once from `[minDelayMs, maxDelayMs]`.
 * `random` is injected so the choice is testable.
 */
export function pickDelayMs(settings: CrawlSettings, random: () => number = Math.random): number {
  const spread = settings.maxDelayMs - settings.minDelayMs;
  return settings.minDelayMs + Math.floor(random() * (spread + 1));
}

/**
 * Read one namespace and validate it. A missing row is `null` (callers decide
 * what "unset" means); a stored value that no longer matches its schema is a
 * failure, so the caller can fall back and record why.
 */
export async function getSetting<S extends z.ZodType>(
  key: string,
  schema: S,
): Promise<Result<z.output<S> | null>> {
  try {
    const rows = await db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, key))
      .limit(1);

    const row = rows[0];
    if (row === undefined) return ok(null);

    const parsed = schema.safeParse(row.value);
    if (!parsed.success) {
      return fail('VALIDATION_FAILED', `设置 ${key} 不合法：${formatIssues(parsed.error)}`);
    }
    return ok(parsed.data);
  } catch (error) {
    return storageFailure('读取设置', error);
  }
}

/**
 * Upsert one namespace. The caller validates first (the server action does),
 * so this stays a plain write rather than a second, silently diverging schema.
 */
export async function setSetting(
  key: string,
  value: unknown,
): Promise<Result<{ updatedAt: Date }>> {
  try {
    const rows = await db
      .insert(settings)
      .values({
        key,
        value: sql`${JSON.stringify(value)}::jsonb`,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: settings.key,
        set: {
          value: sql`${JSON.stringify(value)}::jsonb`,
          updatedAt: new Date(),
        },
      })
      .returning({ updatedAt: settings.updatedAt });

    const row = rows[0];
    if (row === undefined) return fail('STORAGE_FAILED', '写入设置失败');
    return ok({ updatedAt: row.updatedAt });
  } catch (error) {
    return storageFailure('写入设置', error);
  }
}

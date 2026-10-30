'use server';

import { spawn } from 'node:child_process';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { readSessionStatus, type SessionStatus } from '@/lib/crawl/session-status';
import { enqueueS1 } from '@/lib/runs/queue';
import {
  CRAWL_SETTINGS_KEY,
  DEFAULT_CRAWL_SETTINGS,
  crawlSettingsSchema,
  getSetting,
  setSetting,
  type CrawlSettings,
} from '@/lib/settings/store';

const CRAWL_PATH = '/settings/crawl';

export type CrawlErrorCode =
  'VALIDATION_FAILED' | 'STORAGE_FAILED' | 'INVALID_INPUT' | 'SPAWN_FAILED' | 'SESSION_READ_FAILED';

export type CrawlActionResult<T> =
  { ok: true; value: T } | { ok: false; code: CrawlErrorCode; message: string };

function failure<T>(code: CrawlErrorCode, message: string): CrawlActionResult<T> {
  return { ok: false, code, message };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.length > 0 ? issue.path.join('.') : '(root)'}: ${issue.message}`)
    .join('; ');
}

/** Same rule as the login script: a platform name is a directory name, not a path. */
const platformSchema = z
  .string()
  .trim()
  .min(1, '平台不能为空')
  .max(40, '平台名最多 40 个字符')
  .regex(/^[a-z0-9][a-z0-9._-]*$/i, '平台名只能包含字母、数字、点、下划线和连字符');

const runIdSchema = z.number().int('runId 必须是整数').positive('runId 必须为正数');

/**
 * Start `pnpm crawl:login <platform>` detached and return immediately. The
 * browser window is the operator's; the request never waits for it, and this
 * process never reads the profile or its cookies.
 */
export async function startLoginAction(
  platform: unknown,
): Promise<CrawlActionResult<{ started: true }>> {
  const parsed = platformSchema.safeParse(platform);
  if (!parsed.success) return failure('VALIDATION_FAILED', formatIssues(parsed.error));

  try {
    const child = spawn('pnpm', ['crawl:login', parsed.data], {
      cwd: process.cwd(),
      detached: true,
      stdio: 'ignore',
      env: process.env,
    });
    // Without a listener an ENOENT from spawn would crash the server process.
    child.on('error', (error) => {
      console.error('登录进程启动失败:', error);
    });
    // The child owns its session: it must outlive this request and this worker.
    child.unref();
  } catch (error) {
    return failure('SPAWN_FAILED', `无法启动登录进程：${messageOf(error)}`);
  }

  return { ok: true, value: { started: true } };
}

/** Read-only: the page polls this while a login window is open. */
export async function getSessionStatusAction(
  platform: unknown,
): Promise<CrawlActionResult<SessionStatus>> {
  const parsed = platformSchema.safeParse(platform);
  if (!parsed.success) return failure('VALIDATION_FAILED', formatIssues(parsed.error));

  try {
    return { ok: true, value: await readSessionStatus(parsed.data) };
  } catch (error) {
    return failure('SESSION_READ_FAILED', `读取会话目录失败：${messageOf(error)}`);
  }
}

export async function getCrawlSettingsAction(): Promise<CrawlActionResult<CrawlSettings>> {
  const read = await getSetting(CRAWL_SETTINGS_KEY, crawlSettingsSchema);
  if (!read.ok) return failure(read.code, read.message);

  // No row yet is the defaults, not an error: the form must render with values
  // the operator can save as-is.
  return { ok: true, value: read.value ?? DEFAULT_CRAWL_SETTINGS };
}

export async function saveCrawlSettingsAction(
  raw: unknown,
): Promise<CrawlActionResult<CrawlSettings>> {
  const parsed = crawlSettingsSchema.safeParse(raw);
  if (!parsed.success) return failure('VALIDATION_FAILED', formatIssues(parsed.error));

  const saved = await setSetting(CRAWL_SETTINGS_KEY, parsed.data);
  if (!saved.ok) return failure(saved.code, saved.message);

  revalidatePath(CRAWL_PATH);
  return { ok: true, value: parsed.data };
}

/** Re-run S1 for a run whose pages needed a person. */
export async function retryRunAction(
  runId: unknown,
): Promise<CrawlActionResult<{ jobId: string | null }>> {
  const parsed = runIdSchema.safeParse(runId);
  if (!parsed.success) return failure('VALIDATION_FAILED', formatIssues(parsed.error));

  const queued = await enqueueS1(parsed.data);
  if (!queued.ok) return failure(queued.code, queued.message);

  revalidatePath(CRAWL_PATH);
  return { ok: true, value: { jobId: queued.value.jobId } };
}

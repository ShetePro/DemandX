'use server';

import {
  createRun,
  createRunInputSchema,
  createThread,
  createThreadInputSchema,
  formatIssues,
  type CreateRunResult,
  type CreateThreadResult,
  type Result,
} from '@/lib/runs/repository';

/**
 * Actions parse before they execute, and every failure leaves as plain data —
 * a thrown error would surface as an opaque digest on the client.
 */
export async function createThreadAction(raw: unknown): Promise<Result<CreateThreadResult>> {
  const parsed = createThreadInputSchema.safeParse(raw);
  return parsed.success
    ? createThread(parsed.data)
    : { ok: false, code: 'VALIDATION_FAILED', message: formatIssues(parsed.error) };
}

export async function createRunAction(raw: unknown): Promise<Result<CreateRunResult>> {
  const parsed = createRunInputSchema.safeParse(raw);
  return parsed.success
    ? createRun(parsed.data)
    : { ok: false, code: 'VALIDATION_FAILED', message: formatIssues(parsed.error) };
}

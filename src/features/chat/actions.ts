'use server';

import { z } from 'zod';

import {
  createResearch,
  createRun,
  createRunInputSchema,
  createThread,
  createThreadInputSchema,
  formatIssues,
  type CreateResearchResult,
  type CreateRunResult,
  type CreateThreadResult,
  type Result,
} from '@/lib/runs/repository';
import { enqueueS1 } from '@/lib/runs/queue';

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

/**
 * The run row exists before the queue does, so a queue outage must not turn a
 * successful creation into an error the user sees. The failure is logged for
 * the operator; the run stays `queued` and can be re-enqueued.
 */
export async function createRunAction(raw: unknown): Promise<Result<CreateRunResult>> {
  const parsed = createRunInputSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, code: 'VALIDATION_FAILED', message: formatIssues(parsed.error) };
  }

  const created = await createRun(parsed.data);
  if (!created.ok) return created;

  const queued = await enqueueS1(created.value.runId);
  if (!queued.ok) {
    console.error(`⚠️ run ${created.value.runId} 入队失败: ${queued.message}`);
  }

  return created;
}

const startResearchInputSchema = z.strictObject({
  idea: z.string().trim().min(8, '想法至少 8 个字符').max(4000, '想法最多 4000 个字符'),
});

export type StartResearchInput = z.input<typeof startResearchInputSchema>;

/**
 * The first screen's only write: create the idea, thread, first message and run
 * together, then enqueue S1. A queue outage is logged but never reported as a
 * failed start — the run already exists and stays `queued` for a retry.
 */
export async function startResearchAction(raw: unknown): Promise<Result<CreateResearchResult>> {
  const parsed = startResearchInputSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, code: 'VALIDATION_FAILED', message: formatIssues(parsed.error) };
  }

  const created = await createResearch(parsed.data);
  if (!created.ok) return created;

  const queued = await enqueueS1(created.value.runId);
  if (!queued.ok) {
    console.error(`⚠️ run ${created.value.runId} 入队失败: ${queued.message}`);
  }

  return created;
}

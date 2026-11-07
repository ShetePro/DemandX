'use server';

import { z } from 'zod';

import { recordFeedback } from '@/lib/discovery/memory';
import { createResearch, type CreateResearchResult } from '@/lib/runs/repository';
import { enqueueS1 } from '@/lib/runs/queue';

export type DiscoveryActionResult<T> =
  | { ok: true; value: T; warning?: string | undefined }
  | { ok: false; code: DiscoveryErrorCode; message: string };

export type DiscoveryErrorCode =
  | 'VALIDATION_FAILED'
  | 'NO_SOURCES'
  | 'LLM_UNAVAILABLE'
  | 'INVALID_OUTPUT'
  | 'TOO_SIMILAR'
  | 'STORAGE_FAILED'
  | 'QUEUE_FAILED';

/**
 * Starting research from the radar carries the scan it came from, because the
 * feedback is what lets the next scan deepen this angle instead of guessing.
 * The idea string stays the same as a typed pitch, so the resulting thread is
 * indistinguishable from one created in the composer.
 */
const startInputSchema = z.strictObject({
  idea: z.string().trim().min(8, '想法至少 8 个字符').max(4000, '想法最多 4000 个字符'),
  scanId: z.number().int().positive().nullable().optional(),
  title: z.string().trim().min(1).max(120).optional(),
  angle: z.string().trim().min(1).max(40).optional(),
});

/**
 * Turns a discovered opportunity into a normal research thread: same repository
 * path as the new-research composer, so the run, first message and queue entry
 * are indistinguishable from a typed idea.
 */
export async function startDiscoveredResearchAction(
  input: unknown,
): Promise<DiscoveryActionResult<CreateResearchResult>> {
  const parsed = startInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      code: 'VALIDATION_FAILED',
      message: parsed.error.issues[0]?.message ?? '想法无效',
    };
  }

  const created = await createResearch({ idea: parsed.data.idea });
  if (!created.ok) {
    return { ok: false, code: 'STORAGE_FAILED', message: created.message };
  }

  const queued = await enqueueS1(created.value.runId);
  if (!queued.ok) {
    return { ok: false, code: 'QUEUE_FAILED', message: queued.message };
  }

  // Best effort: the thread already exists, so a ledger failure must not look
  // like a failed research. The page surfaces `warning` instead.
  if (parsed.data.title !== undefined) {
    const recorded = await recordFeedback({
      scanId: parsed.data.scanId ?? null,
      opportunityTitle: parsed.data.title,
      angle: parsed.data.angle ?? null,
      threadId: created.value.threadId,
    });
    if (!recorded.ok) {
      return {
        ok: true,
        value: created.value,
        warning: '方向已开始研究，但反馈未记录；下一轮无法参考这次选择。',
      };
    }
  }

  return { ok: true, value: created.value };
}

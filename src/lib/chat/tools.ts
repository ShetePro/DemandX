import { tool, type Tool } from 'ai';
import { z } from 'zod';

import { signalEnum } from '@/lib/db/schema/evidence';
import { createRerun } from '@/lib/runs/repository';
import { enqueueS1 } from '@/lib/runs/queue';

/** The five signal classes, kept in the database's order (see `evidence.ts`). */
export const SIGNALS = signalEnum.enumValues;

export type Signal = (typeof SIGNALS)[number];

/**
 * One evidence row as chat shows it. `summary` is already the human-readable
 * extract; the UI never renders raw post bodies inline.
 */
export type EvidenceItem = {
  id: string;
  platform: string;
  summary: string;
  url?: string;
  signal?: Signal;
};

export const queryEvidenceInputSchema = z.object({
  signal: z.enum(SIGNALS).optional(),
  platform: z.string().trim().min(1).optional(),
  q: z.string().trim().min(1).optional(),
});

export type QueryEvidenceInput = z.infer<typeof queryEvidenceInputSchema>;

export const startResearchInputSchema = z.object({
  idea: z.string().trim().min(8, '想法描述至少 8 个字符'),
  angles: z.array(z.string().trim().min(1)).max(5, '最多 5 个切入角度').optional(),
});

export type StartResearchInput = z.infer<typeof startResearchInputSchema>;

export const rerunResearchInputSchema = z.object({
  reason: z.string().trim().max(200).optional(),
});

export type RerunResearchInput = z.infer<typeof rerunResearchInputSchema>;

export type RerunResearchOutput =
  | { status: 'started'; runId: number }
  | { status: 'unavailable'; message: string }
  | { status: 'failed'; message: string };

export type StartResearchOutput = {
  status: 'needs_confirmation';
  idea: string;
  angles: string[];
};

/** The tool set `/api/chat` streams with; UI message parts are typed from it. */
export type ChatTools = {
  query_evidence: Tool<QueryEvidenceInput, { items: EvidenceItem[] }>;
  start_research: Tool<StartResearchInput, StartResearchOutput>;
  rerun_research: Tool<RerunResearchInput, RerunResearchOutput>;
};

/**
 * No evidence is available before the collection pipeline exists, so the empty
 * answer is the truthful one — the filter arguments are accepted and ignored.
 * P4 replaces this with a read over the evidence table; chat must not query the
 * database before then.
 */
export async function queryEvidence(): Promise<{ items: EvidenceItem[] }> {
  return { items: [] };
}

/** Prepares parameters only: no run is created, nothing is collected. */
export async function prepareStartResearch({
  idea,
  angles,
}: StartResearchInput): Promise<StartResearchOutput> {
  return { status: 'needs_confirmation', idea, angles: angles ?? [] };
}

/**
 * The run is created only after the operator confirms in the approval card —
 * except for `rerun_research`, which the agent may call on its own when the
 * user asks to revalidate an existing conversation.
 */
export function createChatTools(options: { threadId?: number | undefined } = {}): ChatTools {
  const threadId = options.threadId;

  async function rerunResearch(): Promise<RerunResearchOutput> {
    if (threadId === undefined) {
      return { status: 'unavailable', message: '当前对话没有关联会话，无法重新发起研究' };
    }

    const created = await createRerun(threadId);
    if (!created.ok) return { status: 'failed', message: created.message };

    const queued = await enqueueS1(created.value.runId);
    if (!queued.ok) {
      return { status: 'failed', message: `研究已创建但入队失败：${queued.message}` };
    }
    return { status: 'started', runId: created.value.runId };
  }

  return {
    query_evidence: tool({
      description:
        '检索已采集的证据条目。在没有真实数据时返回空列表——此时应直接告诉用户没有找到足够证据。',
      inputSchema: queryEvidenceInputSchema,
      execute: queryEvidence,
    }),
    start_research: tool({
      description:
        '为一次完整研究准备参数并请求用户确认。不创建 run、不启动采集；用户确认后才由界面创建。',
      inputSchema: startResearchInputSchema,
      execute: prepareStartResearch,
    }),
    rerun_research: tool({
      description:
        '当用户要求“重新验证 / 重跑 / 再研究一次”当前对话的想法时调用。会立即创建新的 run 并入队 S1，不需要用户再次确认；返回 runId 后告知用户已开始。',
      inputSchema: rerunResearchInputSchema,
      execute: rerunResearch,
    }),
  };
}

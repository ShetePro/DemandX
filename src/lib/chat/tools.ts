import { tool, type Tool } from 'ai';
import { z } from 'zod';

import { signalEnum } from '@/lib/db/schema/evidence';
import { searchThreadEvidence } from '@/lib/runs/evidence-repository';
import {
  createRerun,
  getRun,
  listRunsForThread,
  readEvents,
} from '@/lib/runs/repository';
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
  /** A narrower angle chosen from the option panel; appended to the pitch. */
  focus: z.string().trim().max(500).optional(),
});

export type RerunResearchInput = z.infer<typeof rerunResearchInputSchema>;

export const presentOptionsInputSchema = z.object({
  options: z
    .array(
      z.object({
        id: z.string().trim().min(1).max(24),
        label: z.string().trim().min(1).max(30),
        description: z.string().trim().max(120).optional(),
      }),
    )
    .min(2)
    .max(4),
});

export type PresentOptionsInput = z.infer<typeof presentOptionsInputSchema>;

export type RerunResearchOutput =
  | { status: 'started'; runId: number }
  | { status: 'unavailable'; message: string }
  | { status: 'failed'; message: string };

export const runStatusInputSchema = z.object({
  /** Defaults to the newest run of the current thread. */
  runId: z.number().int().positive().optional(),
});

export type RunStatusInput = z.infer<typeof runStatusInputSchema>;

export type RunStatusOutput =
  | {
      status: 'ok';
      runId: number;
      state: string;
      stage: string | null;
      accepted: number | null;
      decision: string | null;
      reportId: number | null;
      /** True while the worker still owns the run. */
      active: boolean;
    }
  | { status: 'unavailable'; message: string };

export type StartResearchOutput = {
  status: 'needs_confirmation';
  idea: string;
  angles: string[];
};

/** The tool set `/api/chat` streams with; UI message parts are typed from it. */
export type ChatTools = {
  query_evidence: Tool<QueryEvidenceInput, { items: EvidenceItem[]; note?: string }>;
  start_research: Tool<StartResearchInput, StartResearchOutput>;
  rerun_research: Tool<RerunResearchInput, RerunResearchOutput>;
  get_run_status: Tool<RunStatusInput, RunStatusOutput>;
  present_options: Tool<PresentOptionsInput, { status: 'shown' }>;
};

/** Reads real evidence rows for this conversation; empty when none exist. */
async function queryEvidence(
  threadId: number | undefined,
  input: QueryEvidenceInput,
): Promise<{ items: EvidenceItem[]; note?: string }> {
  if (threadId === undefined) return { items: [], note: '当前对话没有关联会话。' };

  const filters = {
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    ...(input.platform === undefined ? {} : { platform: input.platform }),
    ...(input.q === undefined ? {} : { q: input.q }),
  };
  let rows = await searchThreadEvidence(threadId, filters);

  // A narrow keyword can miss real evidence ("发票" vs a quote about billing).
  // Falling back to the conversation's evidence beats telling the user the
  // corpus is empty while six rows exist.
  if (rows.ok && rows.value.length === 0 && Object.keys(filters).length > 0) {
    rows = await searchThreadEvidence(threadId, {});
  }
  if (!rows.ok) return { items: [] };

  const items = rows.value.map((row) => ({
      id: String(row.id),
      platform: row.platform,
      summary: row.supports === null ? row.quote : `${row.quote}（${row.supports}）`,
      signal: row.signal,
      ...(row.url === '' ? {} : { url: row.url }),
    }));

  if (items.length > 0) return { items };

  // An empty result must say why it is empty: "still collecting" and "this
  // conversation has no evidence at all" are different answers.
  const runs = await listRunsForThread(threadId);
  const latest = runs.ok ? runs.value.at(-1) : undefined;
  if (latest === undefined) {
    return { items, note: '该会话还没有研究任务；开始研究后证据才会入库。' };
  }
  if (latest.status === 'queued' || latest.status === 'running') {
    return {
      items,
      note: `run #${latest.id} 正在进行（${latest.stage ?? '排队'}）；证据通过 S2 抽取校验后才会入库，现在检索不到是正常的。`,
    };
  }
  if (latest.status === 'failed' || latest.status === 'cancelled') {
    return {
      items,
      note: `run #${latest.id} 已结束（${latest.status}），可能没有可引用的证据。`,
    };
  }
  return { items, note: '该会话目前没有可引用的证据。' };
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

  async function runStatus(input: RunStatusInput): Promise<RunStatusOutput> {
    let runId = input.runId;
    if (runId === undefined) {
      if (threadId === undefined) {
        return { status: 'unavailable', message: '当前对话没有关联会话' };
      }
      const runs = await listRunsForThread(threadId);
      if (!runs.ok) return { status: 'unavailable', message: runs.message };
      runId = runs.value[runs.value.length - 1]?.id;
      if (runId === undefined) return { status: 'unavailable', message: '该会话还没有研究' };
    }

    const run = await getRun(runId);
    if (!run.ok) return { status: 'unavailable', message: run.message };
    if (run.value === null) return { status: 'unavailable', message: `run #${runId} 不存在` };

    const events = await readEvents(runId, 0);
    if (!events.ok) return { status: 'unavailable', message: events.message };

    let accepted: number | null = null;
    let decision: string | null = null;
    let reportId: number | null = null;
    for (const event of events.value) {
      const payload = (event.payload ?? {}) as Record<string, unknown>;
      if (event.type === 'run.finished' && typeof payload.accepted === 'number') {
        accepted = payload.accepted;
      }
      if (event.type === 'report.ready') {
        if (typeof payload.decision === 'string') decision = payload.decision;
        if (typeof payload.reportId === 'number') reportId = payload.reportId;
      }
    }

    return {
      status: 'ok',
      runId,
      state: run.value.status,
      stage: run.value.stage,
      accepted,
      decision,
      reportId,
      active: run.value.status === 'queued' || run.value.status === 'running',
    };
  }

  async function rerunResearch(input: RerunResearchInput): Promise<RerunResearchOutput> {
    if (threadId === undefined) {
      return { status: 'unavailable', message: '当前对话没有关联会话，无法重新发起研究' };
    }

    const created = await createRerun(threadId, input.focus);
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
        '检索本会话已采集的真实证据（可跨历史 run）。如果返回空列表，不要换关键词反复调用：最多再试一次，然后直接用带“推断：”的分析回答，并说明缺少哪类证据。',
      inputSchema: queryEvidenceInputSchema,
      execute: (input) => queryEvidence(threadId, input),
    }),
    start_research: tool({
      description:
        '为一次完整研究准备参数并请求用户确认。不创建 run、不启动采集；用户确认后才由界面创建。',
      inputSchema: startResearchInputSchema,
      execute: prepareStartResearch,
    }),
    present_options: tool({
      description:
        '当回答的结论包含 2–4 个可行下一步时调用，在消息末尾生成可点击的操作面板。用户点击后会以“选择：<label>”作为下一条消息发回。只用于真正的分叉选择，不要用来问开放式问题。',
      inputSchema: presentOptionsInputSchema,
      execute: async () => ({ status: 'shown' }),
    }),
    get_run_status: tool({
      description:
        '查询某个 run 的当前状态、阶段、命中证据数与报告决策。用户询问“跑到哪了 / 完成了吗 / 要不要重跑”时先调用它，按返回的真实状态回答，不得凭印象声称还在跑或已完成；不传 runId 时查当前会话最新的 run。',
      inputSchema: runStatusInputSchema,
      execute: runStatus,
    }),
    rerun_research: tool({
      description:
        '当用户要求“重新验证 / 重跑 / 再研究一次”当前对话的想法时调用。会立即创建新的 run 并入队 S1，不需要用户再次确认；返回 runId 后告知用户已开始。',
      inputSchema: rerunResearchInputSchema,
      execute: rerunResearch,
    }),
  };
}

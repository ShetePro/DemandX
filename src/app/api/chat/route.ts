import { convertToModelMessages, stepCountIs, streamText } from 'ai';
import { z } from 'zod';

import { getChatModel } from '@/lib/chat/model';
import { CHAT_SYSTEM_PROMPT } from '@/lib/chat/system-prompt';
import { createChatTools } from '@/lib/chat/tools';
import type { ChatMessage } from '@/lib/chat/types';
import { getLatestRunForThread } from '@/lib/runs/repository';
import { recordLlmUsage } from '@/lib/llm/usage-recorder';
import { searchThreadEvidence } from '@/lib/runs/evidence-repository';

// Streaming answers are slower than a page render; 60s covers a three-step
// tool loop on a local 7B model without holding the function open indefinitely.
export const maxDuration = 60;
export const dynamic = 'force-dynamic';

/**
 * A deliberately loose subset of `UIMessage`: `parts` stay opaque objects and
 * are type-checked by the SDK's converter, so a new part type shipped by
 * `useChat` does not lock the request out.
 */
const chatRequestSchema = z.object({
  threadId: z.number().int().positive().optional(),
  messages: z.array(
    z.object({
      id: z.string(),
      role: z.enum(['system', 'user', 'assistant']),
      parts: z.array(z.object({ type: z.string() }).loose()),
    }),
  ),
});

/**
 * Tells the model whether this conversation already owns a run. Without it,
 * the auto-answer for a freshly created thread asks "要我开始吗?" while the run
 * is already queued — the user has started it by asking.
 */
async function describeThreadRun(threadId: number | undefined): Promise<string> {
  if (threadId === undefined) return '';

  const latest = await getLatestRunForThread(threadId);
  if (!latest.ok || latest.value === null) return '';

  const run = latest.value;
  return `\n\n该会话已创建研究任务（run #${run.id}，状态 ${run.status}，阶段 ${run.stage ?? '未知'}）。不要再次询问是否开始研究，直接说明你准备如何检索证据；需要证据时调用 query_evidence 并基于返回结果回答。`;
}

/**
 * The conversation's accepted evidence, injected before the model answers.
 * Relying on the model to call `query_evidence` first made weak models claim
 * "没有找到足够证据" while six rows existed, so the rows are always in context.
 */
async function describeThreadEvidence(threadId: number | undefined): Promise<string> {
  if (threadId === undefined) return '';

  const rows = await searchThreadEvidence(threadId, {}, 8);
  if (!rows.ok || rows.value.length === 0) {
    return '\n\n本会话暂无已入库证据；可以说明“尚未找到证据”，并基于明确标注的推断继续分析。';
  }

  const lines = rows.value.map(
    (row) => `- [e${row.id}] ${row.signal} · ${row.platform}：${row.quote.slice(0, 180)}${row.url ? `（${row.url}）` : ''}`,
  );
  return `\n\n本会话已采集的证据（直接引用为 [e<id>]，无需再调用 query_evidence）：\n${lines.join('\n')}`;
}

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'VALIDATION_FAILED' }, { status: 400 });
  }

  const parsed = chatRequestSchema.safeParse(body);
  if (!parsed.success) return Response.json({ error: 'VALIDATION_FAILED' }, { status: 400 });

  const model = await getChatModel();
  if (!model.ok) return Response.json({ error: model.code }, { status: 500 });
  const used = model.value.used;

  const tools = createChatTools({ threadId: parsed.data.threadId });
  const messages = parsed.data.messages as ChatMessage[];
  const [runContext, evidenceContext] = await Promise.all([
    describeThreadRun(parsed.data.threadId),
    describeThreadEvidence(parsed.data.threadId),
  ]);

  try {
    const result = streamText({
      model: model.value.model,
      system: `${CHAT_SYSTEM_PROMPT}${runContext}${evidenceContext}`,
      messages: await convertToModelMessages(messages),
      tools,
      // One retrieval step plus one correction step is enough; a longer loop
      // costs tokens without improving the answer.
      stopWhen: stepCountIs(3),
      // A stuck provider must surface as an error instead of an endless spinner.
      abortSignal: AbortSignal.timeout(60_000),
      // Chat bypasses LlmPort, so it records its own tokens; without this the
      // settings panel only counted pipeline calls.
      onFinish: ({ usage }) => {
        void recordLlmUsage({
          providerId: used.providerId,
          model: used.modelId,
          kind: used.kind,
          promptTokens: usage.inputTokens ?? 0,
          completionTokens: usage.outputTokens ?? 0,
        });
      },
    });

    return result.toUIMessageStreamResponse();
  } catch {
    // The provider was unreachable before the stream opened. Nothing has been
    // sent yet, so a plain JSON error is still a valid response.
    return Response.json({ error: 'CHAT_STREAM_FAILED' }, { status: 500 });
  }
}

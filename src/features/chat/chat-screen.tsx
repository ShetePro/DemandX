'use client';

import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { useStickToBottom } from 'use-stick-to-bottom';

import type { ChatMessage } from '@/lib/chat/types';
import type { RunEvent } from '@/lib/runs/event-reducer';
import { cn } from '@/lib/utils/cn';

import { createRunAction } from './actions';
import { CitationSheet } from './citation-sheet';
import { Composer } from './composer';
import { MessageParts } from './message-parts';
import { RunRail } from './run-rail';

/**
 * `@ai-sdk/react` pins its own copy of `ai` (7.0.15) while the app depends on
 * 7.0.156, so the hook's `UIMessage` and this repo's `ChatMessage` are
 * structurally identical but nominally different. The aliases below are the
 * only place that seam is bridged; everything else keeps the app's types.
 */
type ChatHookOptions = Extract<NonNullable<Parameters<typeof useChat>[0]>, { chat?: never }>;
type ChatHookMessage = NonNullable<ChatHookOptions['messages']>[number];
type ChatHookTransport = NonNullable<ChatHookOptions['transport']>;

/** One transport for the lifetime of the page; it holds no per-thread state. */
const transport = new DefaultChatTransport({
  api: '/api/chat',
}) as unknown as ChatHookTransport;

type RunState = {
  id: number | null;
  evidenceHref: string | null;
  events: RunEvent[];
};

export type ChatScreenProps = {
  threadId: number;
  /** Persisted history, already in `UIMessage` shape. */
  initialMessages: ChatMessage[];
  /** Latest run of the thread, if one exists. */
  runId: number | null;
  /** Real `/runs/:id/evidence` link for citations; `null` before a run. */
  evidenceHref: string | null;
  /** First-paint snapshot for the rail, oldest first. */
  initialRunEvents?: RunEvent[];
  title?: string;
};

/**
 * The whole `/threads/[id]` island: conversation on the left, live run state on
 * the right. The RSC owns history and the first run snapshot; everything after
 * that is `useChat` (messages) plus the SSE rail.
 */
export function ChatScreen({
  threadId,
  initialMessages,
  runId,
  evidenceHref,
  initialRunEvents = [],
  title = '研究对话',
}: ChatScreenProps) {
  const router = useRouter();
  const [run, setRun] = useState<RunState>(() => ({
    id: runId,
    evidenceHref,
    events: initialRunEvents,
  }));
  const [citationId, setCitationId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  const chat = useChat({
    messages: initialMessages as unknown as ChatHookMessage[],
    transport,
    onError: () => toast.error('聊天请求失败，请重试'),
  });
  const messages = chat.messages as unknown as ChatMessage[];
  const { sendMessage, status, stop } = chat;

  const { scrollRef, contentRef } = useStickToBottom({ initial: 'instant' });
  const isStreaming = status === 'submitted' || status === 'streaming';

  async function handleStart(idea: string): Promise<void> {
    if (starting || run.id !== null) return;
    setStarting(true);

    try {
      const result = await createRunAction({ threadId, idea });
      if (!result.ok) {
        toast.error(result.message);
        return;
      }

      setRun({
        id: result.value.runId,
        evidenceHref: `/runs/${result.value.runId}/evidence`,
        events: [],
      });
      toast.success('研究已开始');
      router.refresh();
    } catch {
      toast.error('创建研究失败：网络错误');
    } finally {
      setStarting(false);
    }
  }

  return (
    <div
      className={cn(
        'grid h-full min-h-0 transition-[grid-template-columns] duration-200 ease-out',
        run.id === null
          ? 'grid-cols-1'
          : 'grid-cols-[minmax(0,1fr)_312px] max-lg:grid-cols-1 max-lg:grid-rows-[minmax(0,1fr)_auto]',
      )}
    >
      <section aria-label="对话" className="flex min-h-0 flex-col">
        <header className="flex h-12 shrink-0 items-center border-b border-border px-4">
          <h1 className="truncate text-sm font-semibold text-fg">{title}</h1>
        </header>

        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
          <div ref={contentRef} className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-4 py-6">
            {messages.length === 0 ? (
              <EmptyConversation />
            ) : (
              messages.map((message) => (
                <article
                  key={message.id}
                  className={cn(
                    'min-w-0',
                    message.role === 'user' &&
                      'ml-auto w-fit max-w-[85%] rounded-xl bg-accent-soft px-3 py-2',
                  )}
                >
                  <MessageParts
                    message={message}
                    onOpenCitation={setCitationId}
                    onStart={starting || run.id !== null ? undefined : handleStart}
                  />
                </article>
              ))
            )}
          </div>
        </div>

        <div className="shrink-0 border-t border-border bg-surface px-4 py-3">
          <div className="mx-auto w-full max-w-3xl">
            <Composer
              onSend={(text) => void sendMessage({ text })}
              onStop={stop}
              isStreaming={isStreaming}
            />
          </div>
        </div>
      </section>

      {run.id !== null && (
        <aside
          aria-label="运行详情"
          className="min-h-0 overflow-y-auto border-l border-border bg-surface px-3.5 py-4 max-lg:border-t max-lg:border-l-0"
        >
          <RunRail runId={run.id} initialEvents={run.events} />
        </aside>
      )}

      <CitationSheet
        citationId={citationId}
        evidenceHref={run.evidenceHref}
        onClose={() => setCitationId(null)}
      />
    </div>
  );
}

function EmptyConversation() {
  return (
    <div className="flex flex-col items-center justify-center gap-1 px-4 py-16 text-center">
      <p className="text-sm font-medium text-fg">描述一个产品想法，或粘贴一段用户抱怨</p>
      <p className="text-xs text-muted">助手会先整理研究角度，确认后才开始采集。</p>
    </div>
  );
}

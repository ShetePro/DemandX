'use client';

import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import { useRouter } from 'next/navigation';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useStickToBottom } from 'use-stick-to-bottom';

import type { ChatMessage } from '@/lib/chat/types';
import type { RunEvent } from '@/lib/runs/event-reducer';
import type { AssistantMessagePart } from '@/lib/runs/repository';
import { cn } from '@/lib/utils/cn';

import { appendAssistantMessageAction, createRunAction } from './actions';
import { CitationSheet } from './citation-sheet';
import { Composer } from './composer';
import { MessageParts } from './message-parts';
import { RunActivity } from './run-activity';

/**
 * `@ai-sdk/react` pins its own copy of `ai` (7.0.15) while the app depends on
 * 7.0.156, so the hook's `UIMessage` and this repo's `ChatMessage` are
 * structurally identical but nominally different. The aliases below are the
 * only place that seam is bridged; everything else keeps the app's types.
 */
type ChatHookOptions = Extract<NonNullable<Parameters<typeof useChat>[0]>, { chat?: never }>;
type ChatHookMessage = NonNullable<ChatHookOptions['messages']>[number];
type ChatHookTransport = NonNullable<ChatHookOptions['transport']>;

/**
 * Space between the last transcript item and the composer card. The floating
 * wrapper already adds its own `pb-4`, so the content padding must cover the
 * card, that inset, and the visible gap.
 */
const COMPOSER_CLEARANCE = 16 + 16;

type RunState = {
  id: number | null;
  evidenceHref: string | null;
  events: RunEvent[];
};

export type ChatScreenProps = {
  threadId: number;
  /** Persisted history, already in `UIMessage` shape. */
  initialMessages: ChatMessage[];
  /**
   * The first question, sent automatically when the thread has no saved answer
   * yet. The RSC only supplies it for a run whose assistant turn is missing, so
   * a reloaded or finished conversation asks nothing.
   */
  autoPrompt?: string | undefined;
  /** Latest run of the thread, if one exists. */
  runId: number | null;
  /** Database status/stage for the rail seed. */
  runStatus?: string | undefined;
  runStage?: string | null | undefined;
  /** Real `/runs/:id/evidence` link for citations; `null` before a run. */
  evidenceHref: string | null;
  /** First-paint snapshot for the rail, oldest first. */
  initialRunEvents?: RunEvent[];
  /** False when the worker has not checked in; queued runs are then stalled. */
  workerOnline?: boolean | undefined;
  title?: string;
};

/**
 * Drop the last user turn before seeding `useChat` with the auto prompt. The
 * pitch is already persisted (one user row), and `sendMessage` adds it again —
 * keeping both would show the question twice.
 */
function withoutLastUserTurn(messages: ChatMessage[]): ChatMessage[] {
  const last = messages[messages.length - 1];
  return last !== undefined && last.role === 'user' ? messages.slice(0, -1) : messages;
}

/**
 * What a refresh keeps: the answer's text and its reasoning. Tool and data
 * parts are re-created by the next request, so storing them would only pin a
 * stale fragment of the UI into history.
 */
function persistableParts(message: ChatMessage): AssistantMessagePart[] {
  const parts: AssistantMessagePart[] = [];
  for (const part of message.parts) {
    if (part.type !== 'text' && part.type !== 'reasoning') continue;
    if (part.text.trim() === '') continue;
    parts.push({ type: part.type, text: part.text });
  }
  return parts;
}

/**
 * The whole `/threads/[id]` island: conversation on the left, live run state on
 * the right. The RSC owns history and the first run snapshot; everything after
 * that is `useChat` (messages) plus the SSE rail.
 */
export function ChatScreen({
  threadId,
  initialMessages,
  autoPrompt,
  runId,
  runStatus,
  runStage,
  evidenceHref,
  initialRunEvents = [],
  workerOnline = true,
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
  /** One auto prompt per mount, even if an effect runs twice in StrictMode. */
  const autoSent = useRef(false);

  const hasPersistedAssistant = initialMessages.some((message) => message.role === 'assistant');
  // The seed is fixed for the life of the hook; a new array per render would
  // only churn the transport's first-message bookkeeping.
  const seededMessages = useMemo(
    () =>
      (autoPrompt === undefined
        ? initialMessages
        : withoutLastUserTurn(initialMessages)) as unknown as ChatHookMessage[],
    [autoPrompt, initialMessages],
  );

  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: '/api/chat',
        // The route needs the thread to tell the model a run already exists,
        // so the answer plans the research instead of asking to start it.
        body: { threadId },
      }) as unknown as ChatHookTransport,
    [threadId],
  );

  const chat = useChat({
    messages: seededMessages,
    transport,
    onError: () => toast.error('聊天请求失败，请重试'),
    // The reply is only streamed; without this write a refresh would lose it.
    onFinish: ({ message }) => {
      const parts = persistableParts(message as unknown as ChatMessage);
      if (parts.length === 0) return;

      void appendAssistantMessageAction(threadId, parts).then(
        (result) => {
          if (result.ok) return;
          toast.error(`保存回复失败：${result.message}`);
        },
        () => toast.error('保存回复失败：网络错误'),
      );
    },
  });
  const messages = chat.messages as unknown as ChatMessage[];
  const { sendMessage, status, stop } = chat;

  const { scrollRef, contentRef } = useStickToBottom({ initial: 'instant' });

  // The composer floats over the transcript, so the content needs exactly its
  // measured height (plus a gap) as bottom padding — a fixed value clips the
  // last message as soon as the textarea grows to several lines.
  const composerRef = useRef<HTMLDivElement>(null);
  const [composerHeight, setComposerHeight] = useState(0);

  useLayoutEffect(() => {
    const element = composerRef.current;
    if (element === null) return;
    const target = element;

    function measure(): void {
      setComposerHeight(target.getBoundingClientRect().height);
    }
    measure();

    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(target);
    return () => observer.disconnect();
  }, []);
  const isStreaming = status === 'submitted' || status === 'streaming';

  // Ask the question the thread was created for. The server states it only when
  // no answer is stored yet, and `hasPersistedAssistant` re-checks that here so
  // a stale prop can never produce a second turn.
  useEffect(() => {
    if (autoPrompt === undefined || hasPersistedAssistant || autoSent.current) return;
    autoSent.current = true;
    void sendMessage({ text: autoPrompt });
  }, [autoPrompt, hasPersistedAssistant, sendMessage]);

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
    <div className="grid h-full min-h-0 grid-cols-1">
      <section aria-label="对话" className="relative flex min-h-0 flex-col">
        <header className="flex h-12 shrink-0 items-center border-b border-border px-4">
          <h1 className="truncate text-sm font-semibold text-fg">{title}</h1>
        </header>

        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
          <div
            ref={contentRef}
            className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-4 pt-6 pb-32"
            style={
              composerHeight === 0
                ? undefined
                : { paddingBottom: composerHeight + COMPOSER_CLEARANCE }
            }
          >
            {messages.length === 0 ? (
              <EmptyConversation />
            ) : (
              messages.map((message) => (
                <article
                  key={message.id}
                  className={cn(
                    'max-w-full min-w-0 overflow-x-clip',
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

            {/* The run speaks on the assistant side of the transcript: stage,
                progress and the last few queries, folded to one line at the end. */}
            <RunActivity
              runId={run.id}
              initialEvents={run.events}
              status={runStatus}
              stage={runStage}
              workerOnline={workerOnline}
            />
          </div>
        </div>

        {/* Floats over the transcript: no footer band, the thread keeps the page colour. */}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 px-4 pb-4">
          <div ref={composerRef} className="pointer-events-auto mx-auto w-full max-w-3xl">
            <Composer
              onSend={(text) => void sendMessage({ text })}
              onStop={stop}
              isStreaming={isStreaming}
            />
          </div>
        </div>
      </section>

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

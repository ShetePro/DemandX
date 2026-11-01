import Link from 'next/link';
import { notFound } from 'next/navigation';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ChatScreen } from '@/features/chat/chat-screen';
import { EvidencePanel } from '@/features/evidence/evidence-panel';
import { ReportPanel } from '@/features/report/report-panel';
import { ThreadTabs } from '@/features/threads/thread-tabs';
import { parseThreadView } from '@/features/threads/views';
import { PlanPanel } from '@/features/validation/plan-panel';
import type { ChatMessage } from '@/lib/chat/types';
import { toRunEvents, type RunEvent } from '@/lib/runs/event-reducer';
import {
  getLatestRunForThread,
  getMessages,
  getRunContext,
  getThread,
  hasAssistantMessage,
  readEvents,
  type MessageRecord,
} from '@/lib/runs/repository';
import { readWorkerStatus } from '@/lib/runs/worker-heartbeat';

// History and the run snapshot must reflect the database on every request.
export const dynamic = 'force-dynamic';

type ThreadPageProps = {
  params: Promise<{ threadId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

/** Persisted rows only ever hold UIMessage parts; unknown shapes are skipped. */
function toChatMessages(records: MessageRecord[]): ChatMessage[] {
  const messages: ChatMessage[] = [];

  for (const record of records) {
    if (record.role !== 'user' && record.role !== 'assistant' && record.role !== 'system') {
      continue;
    }
    if (!Array.isArray(record.parts)) continue;

    messages.push({
      id: String(record.id),
      role: record.role,
      parts: record.parts as ChatMessage['parts'],
    });
  }

  return messages;
}

/**
 * The question the assistant must answer on first paint: the run's own idea.
 * Only asked when the thread has no assistant turn yet, so a finished
 * conversation never re-asks on every visit.
 */
async function firstPrompt(runId: number): Promise<string | undefined> {
  const context = await getRunContext(runId);
  if (!context.ok) throw new Error(context.message);

  const idea = context.value?.idea.trim() ?? '';
  return idea === '' ? undefined : idea;
}

/** The 对话 tab: history, the latest run and its event tail for the rail. */
async function ChatView({ threadId, title }: { threadId: number; title: string }) {
  const [messages, latestRun, assistant, worker] = await Promise.all([
    getMessages(threadId),
    getLatestRunForThread(threadId),
    hasAssistantMessage(threadId),
    readWorkerStatus(),
  ]);
  if (!messages.ok) throw new Error(messages.message);
  if (!latestRun.ok) throw new Error(latestRun.message);
  if (!assistant.ok) throw new Error(assistant.message);

  const run = latestRun.value;
  let events: RunEvent[] = [];

  if (run !== null) {
    const storedEvents = await readEvents(run.id, 0);
    if (!storedEvents.ok) throw new Error(storedEvents.message);
    events = toRunEvents(storedEvents.value);
  }

  const autoPrompt = run === null || assistant.value ? undefined : await firstPrompt(run.id);

  return (
    <ChatScreen
      key={threadId}
      threadId={threadId}
      title={title}
      initialMessages={toChatMessages(messages.value)}
      autoPrompt={autoPrompt}
      runId={run?.id ?? null}
      runStatus={run?.status}
      runStage={run?.stage}
      evidenceHref={run === null ? null : `/runs/${run.id}/evidence`}
      initialRunEvents={events}
      workerOnline={worker.online}
    />
  );
}

/**
 * A conversation that has never been run has no evidence, report or plan to
 * read; guessing a stage here would be the one thing the app never does.
 */
function NoRunYet({ threadId }: { threadId: number }) {
  return (
    <div className="mx-auto w-full max-w-[900px] p-4 md:p-6">
      <Card className="px-4 py-10 text-center">
        <p className="text-sm font-medium text-fg">还没有开始研究</p>
        <p className="mt-1 text-xs leading-relaxed text-muted">
          在对话里描述想法并开始研究后，这里会显示真实采集的证据、报告与验证计划。
        </p>
        <Button asChild className="mt-4" variant="ghost" size="sm">
          <Link href={`/threads/${threadId}`}>回到对话</Link>
        </Button>
      </Card>
    </div>
  );
}

/**
 * A conversation with views instead of routes: 对话 / 证据 / 报告 / 计划 all
 * render under `/threads/:id?view=…`, so switching never loses the thread. The
 * run-backed views read through the same loaders as `/runs/:id/…`.
 */
export default async function ThreadPage({ params, searchParams }: ThreadPageProps) {
  const { threadId: rawThreadId } = await params;
  const threadId = Number(rawThreadId);

  if (!Number.isSafeInteger(threadId) || threadId <= 0) notFound();

  const thread = await getThread(threadId);
  if (!thread.ok) throw new Error(thread.message);
  if (thread.value === null) notFound();

  const query = await searchParams;
  const view = parseThreadView(query.view);

  if (view === 'chat') {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <ThreadTabs view={view} />
        <div className="min-h-0 flex-1">
          <ChatView threadId={threadId} title={thread.value.title} />
        </div>
      </div>
    );
  }

  const latestRun = await getLatestRunForThread(threadId);
  if (!latestRun.ok) throw new Error(latestRun.message);
  const run = latestRun.value;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ThreadTabs view={view} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {run === null ? (
          <NoRunYet threadId={threadId} />
        ) : view === 'evidence' ? (
          <EvidencePanel runId={run.id} searchParams={query} embedded />
        ) : view === 'report' ? (
          <ReportPanel runId={run.id} embedded />
        ) : (
          <PlanPanel runId={run.id} embedded />
        )}
      </div>
    </div>
  );
}

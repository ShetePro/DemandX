import { notFound } from 'next/navigation';

import { ChatScreen } from '@/features/chat/chat-screen';
import type { ChatMessage } from '@/lib/chat/types';
import { toRunEvents, type RunEvent } from '@/lib/runs/event-reducer';
import {
  getLatestRunForThread,
  getMessages,
  getThread,
  readEvents,
  type MessageRecord,
} from '@/lib/runs/repository';

// History and the run snapshot must reflect the database on every request.
export const dynamic = 'force-dynamic';

type ThreadPageProps = { params: Promise<{ threadId: string }> };

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

export default async function ThreadPage({ params }: ThreadPageProps) {
  const { threadId: rawThreadId } = await params;
  const threadId = Number(rawThreadId);

  if (!Number.isSafeInteger(threadId) || threadId <= 0) notFound();

  const [thread, messages] = await Promise.all([getThread(threadId), getMessages(threadId)]);
  if (!thread.ok) throw new Error(thread.message);
  if (thread.value === null) notFound();
  if (!messages.ok) throw new Error(messages.message);

  const latestRun = await getLatestRunForThread(threadId);
  if (!latestRun.ok) throw new Error(latestRun.message);

  const run = latestRun.value;
  let events: RunEvent[] = [];

  if (run !== null) {
    const storedEvents = await readEvents(run.id, 0);
    if (!storedEvents.ok) throw new Error(storedEvents.message);
    events = toRunEvents(storedEvents.value);
  }

  return (
    <ChatScreen
      key={threadId}
      threadId={threadId}
      title={thread.value.title}
      initialMessages={toChatMessages(messages.value)}
      runId={run?.id ?? null}
      evidenceHref={run === null ? null : `/runs/${run.id}/evidence`}
      initialRunEvents={events}
    />
  );
}

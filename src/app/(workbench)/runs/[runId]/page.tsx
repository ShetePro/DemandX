import Link from 'next/link';
import { notFound } from 'next/navigation';

import { PageHeader } from '@/components/common/page-header';
import { Button } from '@/components/ui/button';
import { QueryTable } from '@/features/runs/query-table';
import { RunMonitor } from '@/features/runs/run-monitor';
import { isTerminalStatus, toRunEvents } from '@/lib/runs/event-reducer';
import { getRun, getRunContext, readRecentEvents } from '@/lib/runs/repository';
import {
  listQueries,
  listRecentSourceEvents,
  summarizeSourceEvents,
} from '@/lib/runs/sources-repository';
import { stageLabel } from '@/lib/runs/stages';
import { hasReport } from '@/lib/report/read';
import { formatDuration } from '@/lib/utils/format';

// Status, elapsed time and the event tail change on every request.
export const dynamic = 'force-dynamic';

type RunPageProps = {
  params: Promise<{ runId: string }>;
};

/** `runs.error` is a structured `{ code, message }`; only the code is short enough for the banner. */
function errorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('code' in error)) return null;
  const { code } = error;
  return typeof code === 'string' && code.length > 0 ? code : null;
}

function ideaTitle(idea: string): string {
  const title = idea.replace(/\s+/g, ' ').trim().slice(0, 60);
  return title === '' ? '运行监控' : title;
}

function elapsedLabel(
  startedAt: Date | null,
  finishedAt: Date | null,
  status: string,
  now: number,
): string {
  if (startedAt === null) return '—';
  if (finishedAt !== null) {
    return formatDuration(finishedAt.getTime() - startedAt.getTime());
  }
  if (isTerminalStatus(status)) return '—';
  return formatDuration(Math.max(0, now - startedAt.getTime()));
}

export default async function RunPage({ params }: RunPageProps) {
  const { runId: rawRunId } = await params;
  const runId = Number(rawRunId);
  if (!Number.isSafeInteger(runId) || runId <= 0) notFound();

  const [run, context, events, queries, summary, failures, reportExists] = await Promise.all([
    getRun(runId),
    getRunContext(runId),
    readRecentEvents(runId),
    listQueries(runId),
    summarizeSourceEvents(runId),
    listRecentSourceEvents(runId, 10),
    hasReport(runId),
  ]);

  if (!run.ok) throw new Error(run.message);
  if (run.value === null) notFound();
  if (!context.ok) throw new Error(context.message);
  if (context.value === null) notFound();
  if (!events.ok) throw new Error(events.message);
  if (!queries.ok) throw new Error(queries.message);
  if (!summary.ok) throw new Error(summary.message);
  if (!failures.ok) throw new Error(failures.message);
  if (!reportExists.ok) throw new Error(reportExists.message);

  const record = run.value;
  const now = new Date().getTime();
  const stage = stageLabel(record.stage) ?? '尚未开始';
  const elapsed = elapsedLabel(record.startedAt, record.finishedAt, record.status, now);
  const threadHref = record.threadId === null ? '/threads/new' : `/threads/${record.threadId}`;

  return (
    <div className="mx-auto max-w-[1200px] p-6">
      <PageHeader
        title={`运行监控 · ${ideaTitle(context.value.idea)}`}
        description={`run #${runId} · 状态 ${record.status} · 阶段 ${stage} · 耗时 ${elapsed}`}
        actions={
          <>
            <Button variant="ghost" size="sm" asChild>
              <Link href={`/runs/${runId}/plan`}>验证计划</Link>
            </Button>
            {reportExists.value ? (
              <Button variant="ghost" size="sm" asChild>
                <Link href={`/runs/${runId}/report`}>查看报告</Link>
              </Button>
            ) : null}
            <Button variant="ghost" size="sm" asChild>
              <Link href={`/runs/${runId}/evidence`}>查看证据库</Link>
            </Button>
            <Button variant="ghost" size="sm" asChild>
              <Link href={threadHref}>返回对话</Link>
            </Button>
          </>
        }
      />

      <div className="flex flex-col gap-4">
        <RunMonitor
          runId={runId}
          initialEvents={toRunEvents(events.value)}
          initialStatus={record.status}
          initialStage={record.stage}
          initialError={errorCode(record.error)}
          startedAt={record.startedAt}
          finishedAt={record.finishedAt}
          deadlineAt={record.deadlineAt}
          initialSummary={summary.value}
          initialFailures={failures.value}
          serverNow={now}
        />

        <QueryTable rows={queries.value} />
      </div>
    </div>
  );
}

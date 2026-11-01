'use client';

import { useRunStream } from '@/lib/hooks/use-run-stream';
import type { RunEvent, RunStateSeed } from '@/lib/runs/event-reducer';
import { STATUS_META, stageLabel } from '@/lib/runs/stages';

import { describeEvent, summarizeState } from './run-activity';

export interface RunInlineProgressProps {
  runId: number;
  events?: RunEvent[];
  status?: string | undefined;
  stage?: string | null | undefined;
  workerOnline?: boolean | undefined;
}

/**
 * The chat-side progress line for one run. Full cards live in the right deck;
 * here only the current stage, counters and the newest query/source events are
 * streamed, so the answer area never waits on a bare spinner.
 */
export function RunInlineProgress({
  runId,
  events = [],
  status,
  stage,
  workerOnline = true,
}: RunInlineProgressProps) {
  const { state } = useRunStream(runId, events, { status, stage } satisfies RunStateSeed);

  if (state.terminal) {
    return (
      <p
        role="status"
        className="flex items-baseline gap-2 rounded-lg bg-surface-2/40 px-3 py-1.5 text-[11px] text-muted"
      >
        <span className="shrink-0 font-mono text-[10px] text-faint">run #{runId}</span>
        <span className="min-w-0 truncate">{summarizeState(state)}</span>
      </p>
    );
  }

  if (state.events.length === 0 && (workerOnline || state.status !== 'queued')) return null;

  const activity = state.events
    .filter((event) => event.type.startsWith('query.') || event.type === 'source.added')
    .slice(-3);

  return (
    <div
      role="status"
      aria-label={`研究进度 run #${runId}`}
      className="rounded-lg border border-border/70 bg-surface-2/30 px-3 py-2 text-[11px] text-muted"
    >
      <div className="flex items-center gap-2">
        <span className="size-1.5 animate-pulse rounded-full bg-accent" aria-hidden="true" />
        <span className="font-medium text-fg">研究进行中</span>
        <span className="font-mono text-[10px] text-faint">run #{runId}</span>
        <span className="ml-auto text-[10.5px]">
          {stageLabel(state.stage) ?? '等待开始'} · {STATUS_META[state.status].label}
        </span>
      </div>

      {activity.length > 0 ? (
        <ul className="mt-1.5 flex flex-col gap-0.5">
          {activity.map((event) => (
            <li key={event.seq} className="truncate">
              <span className="font-mono text-[10px] text-faint">#{event.seq}</span>{' '}
              {describeEvent(event)}
            </li>
          ))}
        </ul>
      ) : null}

      {!workerOnline && state.status === 'queued' ? (
        <p className="mt-1.5 text-warning">worker 未运行：执行 pnpm worker 后才会开始。</p>
      ) : null}
    </div>
  );
}

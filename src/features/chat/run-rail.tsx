'use client';

import { Check, LoaderCircle, X } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { useRunStream } from '@/lib/hooks/use-run-stream';
import type { RunEvent } from '@/lib/runs/event-reducer';
import {
  RUN_STAGES,
  STATUS_META,
  connectionLabel,
  stageMark,
  type StageMark,
} from '@/lib/runs/stages';
import { cn } from '@/lib/utils/cn';

export type RunRailProps = {
  /** `null` until the operator confirms the approval card. */
  runId: number | null;
  /** First-paint snapshot from the RSC, oldest first. */
  initialEvents?: RunEvent[];
};

/**
 * Right-hand run monitor. The empty branch is the honest state before a run
 * exists: no stage is guessed, because no worker has touched one yet.
 */
export function RunRail({ runId, initialEvents = [] }: RunRailProps) {
  if (runId === null) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-1 px-2 text-center">
        <p className="text-sm font-medium text-fg">尚未开始研究</p>
        <p className="text-xs text-muted">在对话里点击“开始研究”后，进度会实时显示在这里。</p>
      </div>
    );
  }

  return <LiveRunRail key={runId} runId={runId} initialEvents={initialEvents} />;
}

function LiveRunRail({ runId, initialEvents }: { runId: number; initialEvents: RunEvent[] }) {
  const { state, connected, retries } = useRunStream(runId, initialEvents);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold text-fg">运行详情</span>
        <Badge tone={STATUS_META[state.status].tone}>{STATUS_META[state.status].label}</Badge>
      </div>

      <ol className="mt-3 flex flex-col gap-0.5">
        {RUN_STAGES.map((stage, index) => {
          const mark = stageMark(index, state);
          return (
            <li
              key={stage.id}
              aria-current={mark === 'current' ? 'step' : undefined}
              className={cn(
                'flex items-center gap-2 rounded-lg px-2 py-1.5 text-[11.5px]',
                mark === 'current' && 'bg-accent-soft font-semibold text-accent',
                mark === 'done' && 'text-muted',
                mark === 'failed' && 'bg-danger-soft text-danger',
                mark === 'pending' && 'text-faint',
              )}
            >
              <StageDot mark={mark} />
              <span className="flex-1">{stage.label}</span>
            </li>
          );
        })}
      </ol>

      <div className="mt-4 border-t border-border pt-3">
        <div className="flex items-center justify-between gap-2 text-[11px] text-muted">
          <span>最近事件</span>
          <span>共 {state.lastSeq} 条事件</span>
        </div>
        {state.events.length === 0 ? (
          <p className="mt-2 text-[11px] text-faint">还没有事件</p>
        ) : (
          <ul className="mt-2 flex flex-col gap-1">
            {state.events
              .slice(-5)
              .reverse()
              .map((event) => (
                <li key={event.seq} className="flex min-w-0 flex-col gap-0.5">
                  <span className="font-mono text-[10.5px] text-fg">{event.type}</span>
                  <span
                    className="truncate text-[10.5px] text-faint"
                    title={summarize(event.payload)}
                  >
                    {summarize(event.payload)}
                  </span>
                </li>
              ))}
          </ul>
        )}
      </div>

      <p className="mt-auto flex items-center gap-1.5 border-t border-border pt-3 text-[11px] text-muted">
        <span
          aria-hidden="true"
          className={cn(
            'inline-block size-1.5 rounded-full',
            state.terminal ? 'bg-muted' : connected ? 'bg-success' : 'bg-warning',
          )}
        />
        {connectionLabel(state, connected, retries)}
      </p>
    </div>
  );
}

function StageDot({ mark }: { mark: StageMark }) {
  if (mark === 'done') {
    return <Check aria-hidden="true" className="size-3.5 shrink-0 text-success" />;
  }
  if (mark === 'current') {
    return <LoaderCircle aria-hidden="true" className="size-3.5 shrink-0 animate-spin" />;
  }
  if (mark === 'failed') {
    return <X aria-hidden="true" className="size-3.5 shrink-0" />;
  }
  return (
    <span
      aria-hidden="true"
      className="mx-1 inline-block size-1.5 shrink-0 rounded-full bg-border-strong"
    />
  );
}

function formatValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  const json = JSON.stringify(value);
  return json ?? '—';
}

/** One short line for the event log; the full payload stays in the title. */
function summarize(payload: Record<string, unknown>): string {
  const entries = Object.entries(payload).filter(([, value]) => value !== undefined);
  if (entries.length === 0) return '—';
  return entries
    .map(([key, value]) => `${key}: ${formatValue(value)}`)
    .join(' · ')
    .slice(0, 80);
}

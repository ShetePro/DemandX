'use client';

import { useEffect, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import type { RunStreamState } from '@/lib/runs/event-reducer';
import { RUN_STAGES, STATUS_META, stageLabel, stageMark } from '@/lib/runs/stages';
import { cn } from '@/lib/utils/cn';
import { formatDuration } from '@/lib/utils/format';

export interface StageStepperProps {
  /** Live stage/status from the SSE fold, with the RSC values as fallback. */
  state: Pick<RunStreamState, 'stage' | 'status' | 'terminal'>;
  startedAt: Date | null;
  finishedAt: Date | null;
  deadlineAt: Date | null;
  /** Render-stable clock from the server; the component ticks from there. */
  serverNow: number;
}

/**
 * S0–S6 progress. The current stage is marked with `aria-current="step"`; a
 * stage id outside the seven known ones highlights nothing rather than
 * inventing a position. Remaining time is the run's own deadline, which is the
 * only estimate the worker actually enforces — there is no per-stage ETA.
 */
export function StageStepper({
  state,
  startedAt,
  finishedAt,
  deadlineAt,
  serverNow,
}: StageStepperProps) {
  const [now, setNow] = useState(serverNow);

  useEffect(() => {
    if (state.terminal) return;
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [state.terminal]);

  const meta = STATUS_META[state.status];
  const current = stageLabel(state.stage);

  return (
    <section
      aria-labelledby="stage-stepper-heading"
      className="rounded-xl border border-border bg-surface p-4 shadow-sm"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="stage-stepper-heading" className="text-sm font-semibold text-fg">
          阶段进度
        </h2>
        <Badge tone={meta.tone}>{meta.label}</Badge>
      </div>

      <p className="mt-2 text-sm text-fg">
        当前阶段：<span className="font-semibold">{current ?? '尚未开始'}</span>
      </p>
      <p className="mt-0.5 text-xs text-muted">
        {timingLabel(state, startedAt, finishedAt, deadlineAt, now)}
      </p>

      <ol className="mt-4 grid grid-cols-2 gap-1.5 sm:grid-cols-4 lg:grid-cols-7">
        {RUN_STAGES.map((stage, index) => {
          const mark = stageMark(index, state);
          return (
            <li
              key={stage.id}
              aria-current={mark === 'current' ? 'step' : undefined}
              data-mark={mark}
              className={cn(
                'flex items-center gap-1.5 rounded-lg border px-2 py-1.5 text-[11.5px]',
                mark === 'current' && 'border-accent/40 bg-accent-soft font-semibold text-accent',
                mark === 'done' && 'border-border bg-surface text-muted',
                mark === 'failed' && 'border-danger/40 bg-danger-soft text-danger',
                mark === 'pending' && 'border-border bg-surface text-faint',
              )}
            >
              <span
                aria-hidden="true"
                className={cn(
                  'inline-block size-1.5 shrink-0 rounded-full',
                  mark === 'done' && 'bg-success',
                  mark === 'current' && 'animate-pulse bg-accent motion-reduce:animate-none',
                  mark === 'failed' && 'bg-danger',
                  mark === 'pending' && 'bg-border-strong',
                )}
              />
              <span className="truncate">{stage.label}</span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function timingLabel(
  state: Pick<RunStreamState, 'terminal'>,
  startedAt: Date | null,
  finishedAt: Date | null,
  deadlineAt: Date | null,
  now: number,
): string {
  if (state.terminal) {
    if (startedAt !== null && finishedAt !== null) {
      return `本轮已结束，耗时 ${formatDuration(finishedAt.getTime() - startedAt.getTime())}`;
    }
    return '本轮已结束';
  }

  const elapsed =
    startedAt === null ? null : `已运行 ${formatDuration(Math.max(0, now - startedAt.getTime()))}`;

  let remaining: string;
  if (deadlineAt === null) {
    remaining = '未设置截止时间';
  } else if (deadlineAt.getTime() <= now) {
    remaining = '已超过运行截止时间';
  } else {
    remaining = `预计剩余不超过 ${formatDuration(deadlineAt.getTime() - now)}`;
  }

  return elapsed === null ? remaining : `${elapsed} · ${remaining}`;
}

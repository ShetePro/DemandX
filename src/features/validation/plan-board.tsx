'use client';

import { useState } from 'react';
import { toast } from 'sonner';

import { Progress } from '@/components/ui/progress';
import { VALIDATION_PLAN_DAYS } from '@/lib/validation/template';
import { cn } from '@/lib/utils/cn';

import { toggleTaskAction } from './actions';

export interface PlanBoardTask {
  id: number;
  day: number;
  title: string;
  done: boolean;
}

export interface PlanBoardProps {
  runId: number;
  tasks: readonly PlanBoardTask[];
}

const DAYS = Array.from({ length: VALIDATION_PLAN_DAYS }, (_, index) => index + 1);

/**
 * 14-day checklist. The checkbox flips immediately and only rolls back when
 * the server rejects the write, so a slow action never makes the board feel
 * stuck; the progress bar is derived from the same optimistic map.
 */
export function PlanBoard({ runId, tasks }: PlanBoardProps) {
  const [doneById, setDoneById] = useState<Record<number, boolean>>(() =>
    Object.fromEntries(tasks.map((task) => [task.id, task.done])),
  );
  const [pending, setPending] = useState<ReadonlySet<number>>(() => new Set());

  const total = tasks.length;
  const completed = tasks.filter((task) => doneById[task.id] === true).length;
  const percent = total === 0 ? 0 : Math.round((completed / total) * 100);

  function setDone(id: number, done: boolean): void {
    setDoneById((current) => ({ ...current, [id]: done }));
  }

  function setTaskPending(id: number, value: boolean): void {
    setPending((current) => {
      const next = new Set(current);
      if (value) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  async function toggle(task: PlanBoardTask): Promise<void> {
    if (pending.has(task.id)) return;

    const next = doneById[task.id] !== true;
    setDone(task.id, next);
    setTaskPending(task.id, true);

    try {
      const result = await toggleTaskAction(task.id, next);
      if (!result.ok) {
        setDone(task.id, !next);
        toast.error(result.message);
      }
    } catch {
      setDone(task.id, !next);
      toast.error('保存验证计划失败：网络错误');
    } finally {
      setTaskPending(task.id, false);
    }
  }

  return (
    <section aria-labelledby="plan-progress" className="flex flex-col gap-5">
      <div className="rounded-xl border border-border bg-surface p-4 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="plan-progress" className="text-sm font-semibold text-fg">
            完成进度
          </h2>
          <p className="text-sm text-muted tabular-nums" aria-live="polite">
            已完成 <span className="font-semibold text-fg">{completed}</span> / {total}
          </p>
        </div>
        <Progress
          value={percent}
          tone={total > 0 && completed === total ? 'success' : 'accent'}
          className="mt-3"
          aria-label="验证计划完成度"
        />
        <p className="mt-2 text-xs text-muted">
          run #{runId} · 每天一条任务，勾选后立即保存；未完成的任务不会自动推进。
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {DAYS.map((day) => {
          const dayTasks = tasks.filter((task) => task.day === day);
          return (
            <section
              key={day}
              aria-labelledby={`plan-day-${day}`}
              className="rounded-xl border border-border bg-surface p-4 shadow-sm"
            >
              <h3 id={`plan-day-${day}`} className="text-xs font-semibold text-muted">
                Day {day}
              </h3>
              {dayTasks.length === 0 ? (
                <p className="mt-2 text-xs text-faint">暂无任务</p>
              ) : (
                <ul className="mt-2 flex flex-col gap-2">
                  {dayTasks.map((task) => {
                    const done = doneById[task.id] === true;
                    const busy = pending.has(task.id);
                    return (
                      <li key={task.id}>
                        <label className="flex cursor-pointer items-start gap-2.5">
                          <input
                            type="checkbox"
                            checked={done}
                            disabled={busy}
                            aria-label={task.title}
                            onChange={() => void toggle(task)}
                            className="mt-0.5 size-4 shrink-0 cursor-pointer accent-accent disabled:cursor-wait"
                          />
                          <span
                            className={cn(
                              'text-sm leading-5',
                              done ? 'text-muted line-through' : 'text-fg',
                            )}
                          >
                            {task.title}
                          </span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          );
        })}
      </div>
    </section>
  );
}

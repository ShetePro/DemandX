'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

import type { ThreadSummaryRecord } from '@/lib/runs/repository';
import { stageLabel } from '@/lib/runs/stages';
import { cn } from '@/lib/utils/cn';
import { formatScore } from '@/lib/utils/format';

/** Sidebar wording. An unknown database status is shown verbatim instead. */
const STATUS_LABEL: Readonly<Record<string, string>> = {
  not_started: '未开始',
  queued: '排队中',
  running: '进行中',
  paused: '已暂停',
  finished: '已完成',
  failed: '失败',
  cancelled: '已取消',
};

/** Semantic dot per state; `not_started` is deliberately the quietest one. */
const STATUS_DOT: Readonly<Record<string, string>> = {
  not_started: 'bg-faint',
  queued: 'bg-warning',
  running: 'bg-accent',
  paused: 'bg-warning',
  finished: 'bg-success',
  failed: 'bg-danger',
  cancelled: 'bg-danger',
};

/** The conversation the URL points at, or `null` on any other page. */
function activeThreadId(pathname: string): number | null {
  const match = /^\/threads\/(\d+)\/?$/.exec(pathname);
  const raw = match?.[1];
  return raw === undefined ? null : Number(raw);
}

/**
 * `78 · B` once the run has published a report. A total outside 0–100 is not a
 * score this app produced, so it renders as missing rather than throwing.
 */
function scoreLabel(thread: ThreadSummaryRecord): string | null {
  if (!thread.hasReport || thread.score === null) return null;
  if (!Number.isFinite(thread.score) || thread.score < 0 || thread.score > 100) return null;

  const value = formatScore(thread.score);
  return thread.grade === null ? value : `${value} · ${thread.grade}`;
}

function statusLine(thread: ThreadSummaryRecord, compact: boolean): string {
  const label = STATUS_LABEL[thread.status] ?? thread.status;
  if (compact || thread.stage === null) return label;

  const stage = stageLabel(thread.stage);
  return stage === null ? label : `${label} · ${stage}`;
}

export interface ThreadListProps {
  threads: readonly ThreadSummaryRecord[];
  /** Tighter rows for the mobile drawer. */
  compact?: boolean;
  /** Called after a row is activated — the drawer uses it to close itself. */
  onNavigate?: (() => void) | undefined;
  className?: string | undefined;
}

/**
 * The primary navigation: one row per conversation, with the state of its
 * newest run and the report's score. Conversations are the unit of work, so
 * this list replaces per-page destinations entirely.
 */
export function ThreadList({ threads, compact = false, onNavigate, className }: ThreadListProps) {
  const pathname = usePathname();
  const activeId = activeThreadId(pathname);

  return (
    <nav aria-label="会话列表" className={cn('flex min-h-0 flex-col gap-1', className)}>
      <h2 className="px-2.5 text-[11px] font-semibold tracking-wide text-faint">会话</h2>

      {threads.length === 0 ? (
        <p className="px-2.5 py-1 text-[12px] leading-relaxed text-faint">
          还没有会话，点上方新建研究
        </p>
      ) : (
        <ul className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto">
          {threads.map((thread) => {
            const active = thread.id === activeId;
            const score = scoreLabel(thread);

            return (
              <li key={thread.id}>
                <Link
                  href={`/threads/${thread.id}`}
                  aria-current={active ? 'page' : undefined}
                  {...(onNavigate ? { onClick: onNavigate } : {})}
                  className={cn(
                    'flex flex-col gap-0.5 rounded-lg px-2.5 transition-colors',
                    compact ? 'py-1.5' : 'py-2',
                    active
                      ? 'bg-accent-soft text-accent'
                      : 'text-muted hover:bg-surface-2 hover:text-fg',
                  )}
                >
                  <span className="flex w-full items-center gap-2">
                    <span
                      aria-hidden="true"
                      className={cn(
                        'size-1.5 shrink-0 rounded-full',
                        STATUS_DOT[thread.status] ?? 'bg-faint',
                      )}
                    />
                    <span
                      className={cn(
                        'min-w-0 flex-1 truncate text-[13px]',
                        active ? 'font-semibold' : 'font-medium',
                      )}
                    >
                      {thread.title}
                    </span>
                    {score === null ? null : (
                      <span
                        className={cn(
                          'shrink-0 text-[11px] tabular-nums',
                          active ? 'text-accent' : 'text-fg',
                        )}
                      >
                        {score}
                      </span>
                    )}
                  </span>
                  <span
                    className={cn(
                      'truncate pl-3.5 text-[11px]',
                      active ? 'text-accent' : 'text-faint',
                    )}
                  >
                    {statusLine(thread, compact)}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </nav>
  );
}

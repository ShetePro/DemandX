'use client';

import { usePathname } from 'next/navigation';

import type { ThreadSummaryRecord } from '@/lib/runs/repository';
import { cn } from '@/lib/utils/cn';

import { ThreadRow, type DeleteThreadHandler } from './thread-row';

/** The conversation the URL points at, or `null` on any other page. */
function activeThreadId(pathname: string): number | null {
  const match = /^\/threads\/(\d+)(?:\/|$)/.exec(pathname);
  if (match?.[1] === undefined) return null;
  const id = Number(match[1]);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export interface ThreadListProps {
  /** Newest activity first; the caller owns ordering and the cap. */
  threads: readonly ThreadSummaryRecord[];
  /** Deletes a conversation; supplied by the layout. */
  onDelete: DeleteThreadHandler;
  /** Drawer rows drop the stage detail to save vertical space. */
  compact?: boolean;
  /** Called on navigation (closing the mobile drawer). */
  onNavigate?: (() => void) | undefined;
  className?: string;
}

/**
 * The primary navigation: one row per conversation, with the state of its
 * newest run and the report's score. Conversations are the unit of work, so
 * this list replaces per-page destinations entirely.
 *
 * Each row owns its actions (right-click or the hover button) in
 * {@link ThreadRow}; this component only decides which row is current.
 */
export function ThreadList({
  threads,
  onDelete,
  compact = false,
  onNavigate,
  className,
}: ThreadListProps) {
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
          {threads.map((thread) => (
            <ThreadRow
              key={thread.id}
              thread={thread}
              onDelete={onDelete}
              active={thread.id === activeId}
              compact={compact}
              onNavigate={onNavigate}
            />
          ))}
        </ul>
      )}
    </nav>
  );
}

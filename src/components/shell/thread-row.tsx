'use client';

import { MoreHorizontal, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { DeleteThreadResult, Result, ThreadSummaryRecord } from '@/lib/runs/repository';
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

/**
 * `78 · B` once the run has published a report. A total outside 0–100 is not a
 * score this app produced, so it renders as missing rather than throwing.
 */
function scoreLabel(thread: ThreadSummaryRecord): string | null {
  if (thread.score === null || thread.score < 0 || thread.score > 100) return null;
  return thread.grade === null
    ? formatScore(thread.score)
    : `${formatScore(thread.score)} · ${thread.grade}`;
}

function statusLine(thread: ThreadSummaryRecord, compact: boolean): string {
  const label = STATUS_LABEL[thread.status] ?? thread.status;
  if (compact || thread.stage === null) return label;
  return `${label} · ${stageLabel(thread.stage)}`;
}

/** Passed down from the layout, which may import a feature-level action. */
export type DeleteThreadHandler = (threadId: number) => Promise<Result<DeleteThreadResult>>;

export interface ThreadRowProps {
  thread: ThreadSummaryRecord;
  onDelete: DeleteThreadHandler;
  /** The conversation the URL points at; drives both text and dot styling. */
  active: boolean;
  compact: boolean;
  onNavigate?: (() => void) | undefined;
}

/**
 * One sidebar conversation. The row is a link; a right-click opens the same
 * actions menu as the hover button, and deleting asks for confirmation because
 * it also removes the conversation's messages, runs and evidence.
 */
export function ThreadRow({ thread, onDelete, active, compact, onNavigate }: ThreadRowProps) {
  const router = useRouter();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, startDeleting] = useTransition();
  const score = scoreLabel(thread);

  function navigate(): void {
    onNavigate?.();
    router.push(`/threads/${thread.id}`);
  }

  function remove(): void {
    startDeleting(async () => {
      const result = await onDelete(thread.id);
      if (!result.ok) {
        toast.error(`删除会话失败：${result.message}`);
        return;
      }

      setConfirmOpen(false);
      toast.success('会话已删除');
      if (active) router.push('/threads/new');
      router.refresh();
    });
  }

  const rowClassName = cn(
    'flex flex-col gap-0.5 rounded-lg px-2.5 pr-9 transition-colors',
    compact ? 'py-1.5' : 'py-2',
    active ? 'bg-accent-soft text-accent' : 'text-muted hover:bg-surface-2 hover:text-fg',
  );

  const rowContent = (
    <>
      <span className="flex w-full items-center gap-2">
        <span
          aria-hidden="true"
          className={cn('size-1.5 shrink-0 rounded-full', STATUS_DOT[thread.status] ?? 'bg-faint')}
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
            className={cn('shrink-0 text-[11px] tabular-nums', active ? 'text-accent' : 'text-fg')}
          >
            {score}
          </span>
        )}
      </span>
      <span className={cn('truncate pl-3.5 text-[11px]', active ? 'text-accent' : 'text-faint')}>
        {statusLine(thread, compact)}
      </span>
    </>
  );

  return (
    <li className="group relative">
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <Link
            href={`/threads/${thread.id}`}
            {...(active ? { 'aria-current': 'page' as const } : {})}
            {...(onNavigate ? { onClick: onNavigate } : {})}
            className={rowClassName}
          >
            {rowContent}
          </Link>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onSelect={navigate}>打开会话</ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem variant="destructive" onSelect={() => setConfirmOpen(true)}>
            <Trash2 className="size-3.5" aria-hidden="true" />
            删除会话
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={`会话操作：${thread.title}`}
            className={cn(
              'absolute top-1.5 right-1.5 grid size-6 place-items-center rounded-md text-faint opacity-0 transition-opacity',
              'hover:bg-border hover:text-fg focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-accent',
              'group-hover:opacity-100 data-[state=open]:opacity-100',
            )}
          >
            <MoreHorizontal className="size-4" aria-hidden="true" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem onSelect={navigate}>打开会话</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={() => setConfirmOpen(true)}>
            <Trash2 className="size-3.5" aria-hidden="true" />
            删除会话
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>删除会话？</DialogTitle>
            <DialogDescription>
              「{thread.title}」的消息、研究记录与证据都会一并删除，且无法恢复。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <button
              type="button"
              onClick={() => setConfirmOpen(false)}
              className="rounded-lg border border-border px-3 py-1.5 text-[13px] text-muted transition-colors hover:bg-surface-2 hover:text-fg"
            >
              取消
            </button>
            <button
              type="button"
              onClick={remove}
              disabled={deleting}
              className="rounded-lg bg-danger px-3 py-1.5 text-[13px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-60"
            >
              {deleting ? '删除中…' : '删除'}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </li>
  );
}

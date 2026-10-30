'use client';

import { Command } from 'cmdk';
import { Plus } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useCallback, useMemo, useRef, useState } from 'react';

import { useHotkeys } from '@/lib/hooks/use-hotkeys';
import type { ThreadSummaryRecord } from '@/lib/runs/repository';

import { SETTINGS_ITEM } from './nav-items';

/** How many conversations the palette offers before the user narrows it. */
const RECENT_THREAD_LIMIT = 20;

const ITEM_CLASS =
  'flex h-9 cursor-pointer items-center gap-2.5 rounded-lg px-2.5 text-sm text-muted data-[selected=true]:bg-accent-soft data-[selected=true]:text-accent';

const STATUS_LABEL: Readonly<Record<string, string>> = {
  not_started: '未开始',
  queued: '排队中',
  running: '进行中',
  paused: '已暂停',
  finished: '已完成',
  failed: '失败',
  cancelled: '已取消',
};

export interface CommandPaletteProps {
  /** Conversations, newest activity first; sliced to the most recent 20 here. */
  threads: readonly ThreadSummaryRecord[];
}

/**
 * ⌘K / Ctrl-K palette: the two fixed commands plus the recent conversations.
 * Rendering it once in the workbench layout covers every page; cmdk (Radix
 * Dialog) handles focus trapping and Escape.
 *
 * cmdk's dialog has no `Dialog.Trigger`, so Radix drops focus to `<body>` on
 * close; the element that was focused before opening is restored here instead.
 */
export function CommandPalette({ threads }: CommandPaletteProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  const recent = useMemo(() => threads.slice(0, RECENT_THREAD_LIMIT), [threads]);

  useHotkeys('mod+k', () => {
    const active = document.activeElement;
    // Already open: keep focus where it is (Escape closes the palette).
    if (active?.closest('[cmdk-input]')) return;
    restoreFocusRef.current =
      active instanceof HTMLElement && active !== document.body ? active : null;
    setOpen(true);
  });

  const handleOpenChange = useCallback((next: boolean) => {
    setOpen(next);
    if (next) return;

    const target = restoreFocusRef.current;
    restoreFocusRef.current = null;
    // After Radix unmounts the dialog and parks focus on <body>.
    if (target) requestAnimationFrame(() => target.focus());
  }, []);

  const handleSelect = useCallback(
    (href: string) => {
      // Navigation decides where focus belongs next.
      restoreFocusRef.current = null;
      setOpen(false);
      router.push(href);
    },
    [router],
  );

  const SettingsIcon = SETTINGS_ITEM.icon;

  return (
    <Command.Dialog
      open={open}
      onOpenChange={handleOpenChange}
      label="命令面板"
      overlayClassName="fixed inset-0 z-50 bg-bg/80 backdrop-blur-sm"
      contentClassName="fixed top-24 left-1/2 z-50 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 overflow-hidden rounded-xl border border-border bg-surface shadow-lg"
    >
      <Command.Input
        placeholder="搜索会话或命令…"
        className="h-11 w-full border-b border-border bg-transparent px-4 text-sm text-fg outline-none placeholder:text-faint"
      />
      <Command.List className="max-h-72 overflow-y-auto p-1.5">
        <Command.Empty className="px-3 py-6 text-center text-sm text-muted">
          没有匹配的会话或命令
        </Command.Empty>

        <Command.Group
          heading="命令"
          className="[&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:text-faint"
        >
          <Command.Item
            value="新建研究"
            keywords={['new', 'create', 'research']}
            onSelect={() => handleSelect('/threads/new')}
            className={ITEM_CLASS}
          >
            <Plus className="size-4" />
            新建研究
          </Command.Item>
          <Command.Item
            value="设置"
            keywords={SETTINGS_ITEM.keywords}
            onSelect={() => handleSelect(SETTINGS_ITEM.href)}
            className={ITEM_CLASS}
          >
            <SettingsIcon className="size-4" />
            设置
          </Command.Item>
        </Command.Group>

        {recent.length === 0 ? null : (
          <Command.Group
            heading="最近会话"
            className="[&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:text-faint"
          >
            {recent.map((thread) => (
              <Command.Item
                key={thread.id}
                value={thread.title}
                keywords={[STATUS_LABEL[thread.status] ?? thread.status]}
                onSelect={() => handleSelect(`/threads/${thread.id}`)}
                className={ITEM_CLASS}
              >
                <span className="min-w-0 flex-1 truncate">{thread.title}</span>
                <span className="shrink-0 text-[11px] text-faint">
                  {STATUS_LABEL[thread.status] ?? thread.status}
                </span>
              </Command.Item>
            ))}
          </Command.Group>
        )}
      </Command.List>
    </Command.Dialog>
  );
}

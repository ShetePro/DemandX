'use client';

import { Layers, Menu, Plus } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import { ThemeToggle } from '@/components/ui/theme-toggle';
import type { ThreadSummaryRecord } from '@/lib/runs/repository';

import { NavLink } from './nav-links';
import { SETTINGS_ITEM } from './nav-items';
import { ThreadList } from './thread-list';
import type { DeleteThreadHandler } from './thread-row';

export interface MobileNavProps {
  /** Conversations, newest activity first; read by the `(workbench)` layout. */
  threads: readonly ThreadSummaryRecord[];
  /** Supplied by the layout: feature actions cannot be imported from here. */
  onDelete: DeleteThreadHandler;
}

/** The conversation the URL points at, for the top-bar title. */
function activeThreadTitle(
  pathname: string,
  threads: readonly ThreadSummaryRecord[],
): string | null {
  const match = /^\/threads\/(\d+)\/?$/.exec(pathname);
  const raw = match?.[1];
  if (raw === undefined) return null;

  return threads.find((thread) => thread.id === Number(raw))?.title ?? null;
}

/**
 * Mobile top bar (`md:hidden`): menu button, current conversation title and the
 * theme switch. The drawer reuses the same {@link ThreadList} as the desktop
 * sidebar, so both entry points always show the same conversations.
 */
export function MobileNav({ threads, onDelete }: MobileNavProps) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const current =
    activeThreadTitle(pathname, threads) ??
    (pathname.startsWith('/threads/new') ? '新研究' : 'DemandX');

  return (
    <header className="no-print flex h-14 items-center gap-1 border-b border-border bg-surface px-2 md:hidden">
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetTrigger asChild>
          <Button variant="ghost" size="icon" aria-label="打开导航">
            <Menu className="size-4" />
          </Button>
        </SheetTrigger>
        <SheetContent side="right" className="max-w-[280px]">
          <SheetHeader>
            <SheetTitle>会话</SheetTitle>
            <SheetDescription>选择一次研究，或开始新的研究。</SheetDescription>
          </SheetHeader>

          <Button asChild className="w-full">
            <Link href="/threads/new" onClick={() => setOpen(false)}>
              <Plus className="size-4" />
              新建研究
            </Link>
          </Button>

          <ThreadList
            threads={threads}
            onDelete={onDelete}
            compact
            onNavigate={() => setOpen(false)}
            className="min-h-0 flex-1"
          />

          <div className="flex items-center gap-1.5 border-t border-border pt-2.5">
            <NavLink
              item={SETTINGS_ITEM}
              active={SETTINGS_ITEM.isActive(pathname)}
              onNavigate={() => setOpen(false)}
              className="flex-1"
            />
            <ThemeToggle />
          </div>
        </SheetContent>
      </Sheet>

      <Link
        href="/threads/new"
        className="flex min-w-0 items-center gap-2 rounded-lg px-1.5 py-1 text-sm font-semibold text-fg"
      >
        <span className="grid size-6 shrink-0 place-items-center rounded-md bg-linear-to-br from-accent to-s3 text-on-accent">
          <Layers className="size-3.5" />
        </span>
        <span className="truncate">{current}</span>
      </Link>

      <ThemeToggle />
    </header>
  );
}

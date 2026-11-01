'use client';

import { Layers, Lightbulb, Plus, Sparkles } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { Button } from '@/components/ui/button';
import { ThemeToggle } from '@/components/ui/theme-toggle';
import type { ThreadSummaryRecord } from '@/lib/runs/repository';

import { NavLink } from './nav-links';
import { SETTINGS_ITEM } from './nav-items';
import { ThreadList } from './thread-list';
import type { DeleteThreadHandler } from './thread-row';

export interface AppSidebarProps {
  /** Conversations, newest activity first; read by the `(workbench)` layout. */
  threads: readonly ThreadSummaryRecord[];
  /** Supplied by the layout: feature actions cannot be imported from here. */
  onDelete: DeleteThreadHandler;
}

/**
 * Desktop navigation rail (244px, owned by the `(workbench)` layout). Hidden
 * below `md`, where {@link MobileNav} takes over.
 *
 * Brand → 新建研究 → the conversation list (the primary navigation) → settings.
 */
export function AppSidebar({ threads, onDelete }: AppSidebarProps) {
  const pathname = usePathname();

  return (
    <aside className="no-print hidden h-dvh flex-col gap-3.5 border-r border-border bg-surface px-3.5 py-4.5 md:flex">
      <Link
        href="/threads/new"
        className="flex items-center gap-2.5 rounded-lg px-1 pb-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        <div className="grid size-9 shrink-0 place-items-center rounded-[10px] bg-linear-to-br from-accent to-s3 text-on-accent shadow-sm">
          <Layers className="size-[18px]" />
        </div>
        <div className="min-w-0">
          <div className="truncate text-sm font-bold tracking-[0.01em] text-fg">DemandX</div>
          <div className="truncate text-[11px] text-muted">需求验证工作区</div>
        </div>
      </Link>

      <Button asChild className="w-full">
        <Link href="/threads/new">
          <Plus className="size-4" />
          新建研究
        </Link>
      </Button>

      <Link
        href="/discover"
        className="group relative isolate -mt-1.5 flex h-9 w-full items-center justify-center gap-2 rounded-lg border border-accent/50 bg-accent-soft text-[13px] font-medium text-accent transition-colors hover:bg-accent/15 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        <span
          aria-hidden="true"
          className="pointer-events-none absolute -inset-px -z-10 rounded-lg bg-accent/25 opacity-70 blur-md motion-safe:animate-[opportunity-glow_2.8s_ease-in-out_infinite]"
        />
        <span className="relative grid size-4 place-items-center">
          <Lightbulb className="size-4 text-warning motion-safe:animate-[opportunity-lean_3.6s_ease-in-out_infinite]" />
          <Sparkles
            aria-hidden="true"
            className="absolute -top-1.5 -right-1.5 size-2.5 text-accent opacity-0 motion-safe:animate-[opportunity-spark_2.8s_ease-in-out_infinite]"
          />
        </span>
        寻找机会
      </Link>

      <ThreadList threads={threads} onDelete={onDelete} className="min-h-0 flex-1" />

      <div className="flex items-center gap-1.5 border-t border-border pt-2.5">
        <NavLink
          item={SETTINGS_ITEM}
          active={SETTINGS_ITEM.isActive(pathname)}
          className="flex-1"
        />
        <ThemeToggle />
      </div>
    </aside>
  );
}

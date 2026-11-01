'use client';

import { Layers, Plus } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { Button } from '@/components/ui/button';
import { ThemeToggle } from '@/components/ui/theme-toggle';
import type { ThreadSummaryRecord } from '@/lib/runs/repository';

import { NavLink } from './nav-links';
import { OpportunityFinder, type FindResult, type StartResult } from './opportunity-finder';
import { SETTINGS_ITEM } from './nav-items';
import { ThreadList } from './thread-list';
import type { DeleteThreadHandler } from './thread-row';

export interface AppSidebarProps {
  /** Conversations, newest activity first; read by the `(workbench)` layout. */
  threads: readonly ThreadSummaryRecord[];
  /** Supplied by the layout: feature actions cannot be imported from here. */
  onDelete: DeleteThreadHandler;
  /** Opportunity scan and its "start research" follow-up. */
  onFindOpportunities: () => Promise<FindResult>;
  onStartResearch: (idea: string) => Promise<StartResult>;
}

/**
 * Desktop navigation rail (244px, owned by the `(workbench)` layout). Hidden
 * below `md`, where {@link MobileNav} takes over.
 *
 * Brand → 新建研究 → the conversation list (the primary navigation) → settings.
 */
export function AppSidebar({
  threads,
  onDelete,
  onFindOpportunities,
  onStartResearch,
}: AppSidebarProps) {
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

      <OpportunityFinder
        onFind={onFindOpportunities}
        onStart={onStartResearch}
        className="-mt-1.5"
      />

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

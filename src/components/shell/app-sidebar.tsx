'use client';

import { Layers, Plus } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { Button } from '@/components/ui/button';
import { ThemeToggle } from '@/components/ui/theme-toggle';

import { NavLink, NavLinks } from './nav-links';
import { SETTINGS_ITEM } from './nav-items';

/**
 * Desktop navigation rail (244px, owned by the `(workbench)` layout). Hidden
 * below `md`, where {@link MobileNav} takes over.
 */
export function AppSidebar() {
  const pathname = usePathname();

  return (
    <aside className="hidden h-dvh flex-col gap-3.5 border-r border-border bg-surface px-3.5 py-4.5 md:flex">
      <div className="flex items-center gap-2.5 px-1 pb-2">
        <div className="grid size-9 shrink-0 place-items-center rounded-[10px] bg-linear-to-br from-accent to-s3 text-on-accent shadow-sm">
          <Layers className="size-[18px]" />
        </div>
        <div className="min-w-0">
          <div className="truncate text-sm font-bold tracking-[0.01em] text-fg">DemandX</div>
          <div className="truncate text-[11px] text-muted">需求验证工作台</div>
        </div>
      </div>

      <Button asChild className="w-full">
        <Link href="/threads/new">
          <Plus className="size-4" />
          新建研究
        </Link>
      </Button>

      <NavLinks pathname={pathname} />

      <div className="mt-auto flex items-center gap-1.5 border-t border-border pt-2.5">
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

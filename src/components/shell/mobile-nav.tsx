'use client';

import { Layers, Menu } from 'lucide-react';
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

import { NavLink, NavLinks } from './nav-links';
import { NAV_ITEMS, SETTINGS_ITEM } from './nav-items';

/**
 * Mobile top bar (`md:hidden`): menu button, current page title and the theme
 * switch. The drawer reuses the same {@link NavLinks} as the desktop sidebar.
 */
export function MobileNav() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const current = NAV_ITEMS.find((item) => item.isActive(pathname))?.label ?? '工作台';

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
            <SheetTitle>导航</SheetTitle>
            <SheetDescription>在工作台、对话、报告与证据库之间切换</SheetDescription>
          </SheetHeader>
          <NavLinks pathname={pathname} onNavigate={() => setOpen(false)} />
          <div className="mt-auto flex items-center gap-1.5 border-t border-border pt-2.5">
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
        href="/"
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

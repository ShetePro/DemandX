'use client';

import Link from 'next/link';

import { cn } from '@/lib/utils/cn';

import type { NavItem } from './nav-items';

export interface NavLinkProps {
  item: NavItem;
  /** Render the active (current page) treatment and `aria-current="page"`. */
  active?: boolean;
  /** Called after the link is activated — the drawer uses it to close itself. */
  onNavigate?: (() => void) | undefined;
  className?: string | undefined;
}

/**
 * A single fixed destination in the prototype's `.nav-item` shape: 34px tall,
 * 16px icon, active state as `bg-accent-soft text-accent`. The conversation
 * list owns its own row treatment; this is only used for settings.
 */
export function NavLink({ item, active = false, onNavigate, className }: NavLinkProps) {
  const Icon = item.icon;

  return (
    <Link
      href={item.href}
      aria-current={active ? 'page' : undefined}
      {...(onNavigate ? { onClick: onNavigate } : {})}
      className={cn(
        'flex h-8.5 items-center gap-2.5 rounded-lg px-2.5 text-[13px] transition-colors',
        active
          ? 'bg-accent-soft font-semibold text-accent'
          : 'text-muted hover:bg-surface-2 hover:text-fg',
        className,
      )}
    >
      <Icon className="size-4 shrink-0" />
      <span className="truncate">{item.label}</span>
    </Link>
  );
}

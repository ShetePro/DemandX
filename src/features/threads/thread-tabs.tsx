'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';

import { cn } from '@/lib/utils/cn';

import { THREAD_VIEWS, type ThreadView } from './views';

export interface ThreadTabsProps {
  /** The view the RSC rendered; the active tab mirrors it, not the client state. */
  view: ThreadView;
}

/**
 * In-page switch between 对话 / 证据 / 报告 / 计划. Every tab is a link that
 * only changes `?view=`, so the conversation id and any other query (evidence
 * filters) survive and the browser's back button works.
 */
export function ThreadTabs({ view }: ThreadTabsProps) {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  function hrefFor(next: ThreadView): string {
    const params = new URLSearchParams(searchParams.toString());
    // `chat` is the default view, so its URL stays clean.
    if (next === 'chat') params.delete('view');
    else params.set('view', next);

    const query = params.toString();
    return query === '' ? pathname : `${pathname}?${query}`;
  }

  return (
    <nav
      aria-label="会话视图"
      className="no-print flex h-11 shrink-0 items-center gap-1 overflow-x-auto border-b border-border bg-surface px-4"
    >
      {THREAD_VIEWS.map((tab) => {
        const active = tab.value === view;
        return (
          <Link
            key={tab.value}
            href={hrefFor(tab.value)}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'flex h-full items-center border-b-2 px-2.5 text-[13px] whitespace-nowrap transition-colors',
              active
                ? 'border-accent font-semibold text-fg'
                : 'border-transparent text-muted hover:text-fg',
            )}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}

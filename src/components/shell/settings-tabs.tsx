'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { cn } from '@/lib/utils/cn';

const TABS: ReadonlyArray<{ href: string; label: string }> = [
  { href: '/settings/llm', label: 'LLM 与模型' },
  { href: '/settings/crawl', label: '采集设置' },
];

/**
 * Secondary navigation for the settings tree. One sidebar entry ("LLM 与采集")
 * would land on only one of the two pages, so each page carries this strip and
 * both directions stay reachable without expanding the primary nav.
 */
export function SettingsTabs() {
  const pathname = usePathname();

  return (
    <nav aria-label="设置" className="mb-4 flex gap-1 border-b border-border">
      {TABS.map((tab) => {
        const active = pathname === tab.href || pathname.startsWith(`${tab.href}/`);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'border-b-2 px-2.5 pb-2 text-[13px] transition-colors',
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

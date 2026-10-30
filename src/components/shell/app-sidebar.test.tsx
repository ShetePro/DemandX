import { render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ThemeProvider } from '@/components/theme-provider';
import type { ThreadSummaryRecord } from '@/lib/runs/repository';

import { AppSidebar } from './app-sidebar';

const pathname = vi.hoisted(() => ({ current: '/threads/2' }));

vi.mock('next/navigation', () => ({ usePathname: () => pathname.current }));

// Real `next/link` needs a mounted app router; an anchor is enough here.
vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: ComponentProps<'a'> & { href: string }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

const THREADS: ThreadSummaryRecord[] = [
  {
    id: 1,
    title: '跨境库存同步工具',
    updatedAt: new Date('2026-10-30T10:00:00.000Z'),
    status: 'running',
    stage: 'S2',
    score: null,
    grade: null,
    decision: null,
    hasReport: false,
  },
  {
    id: 2,
    title: '给独立开发者的账单工具',
    updatedAt: new Date('2026-10-30T09:00:00.000Z'),
    status: 'finished',
    stage: 'S6',
    score: 78,
    grade: 'B',
    decision: '建议先验证，再开发',
    hasReport: true,
  },
];

function renderSidebar(threads: ThreadSummaryRecord[] = THREADS) {
  return render(
    <ThemeProvider>
      <AppSidebar threads={threads} />
    </ThemeProvider>,
  );
}

function link(name: string | RegExp) {
  return screen.getByRole('link', { name });
}

beforeEach(() => {
  pathname.current = '/threads/2';
});

describe('AppSidebar', () => {
  it('links the brand and the primary action to the new-research screen', () => {
    renderSidebar();

    expect(link(/DemandX/)).toHaveAttribute('href', '/threads/new');
    expect(link(/新建研究/)).toHaveAttribute('href', '/threads/new');
    expect(link('LLM 与采集')).toHaveAttribute('href', '/settings/llm');
  });

  it('navigates by conversation: one row per thread, none of the old pages', () => {
    renderSidebar();

    expect(screen.getByRole('navigation', { name: '会话列表' })).toBeVisible();
    expect(link(/跨境库存同步工具/)).toHaveAttribute('href', '/threads/1');
    expect(link(/给独立开发者的账单工具/)).toHaveAttribute('href', '/threads/2');

    for (const gone of ['工作台', '对话', '报告', '证据库']) {
      expect(screen.queryByRole('link', { name: gone })).not.toBeInTheDocument();
    }
  });

  it('marks the conversation the URL points at', () => {
    renderSidebar();

    expect(link(/给独立开发者的账单工具/)).toHaveAttribute('aria-current', 'page');
    expect(link(/跨境库存同步工具/)).not.toHaveAttribute('aria-current');
    expect(link('LLM 与采集')).not.toHaveAttribute('aria-current');
  });

  it('marks settings as current inside the settings tree', () => {
    pathname.current = '/settings/llm';
    renderSidebar();

    expect(link('LLM 与采集')).toHaveAttribute('aria-current', 'page');
    for (const thread of THREADS)
      expect(link(new RegExp(thread.title))).not.toHaveAttribute('aria-current');
  });

  it('invites a first research when there is no conversation yet', () => {
    renderSidebar([]);

    expect(screen.getByText('还没有会话，点上方新建研究')).toBeVisible();
  });
});

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ThemeProvider } from '@/components/theme-provider';
import type { ThreadSummaryRecord } from '@/lib/runs/repository';

import { MobileNav } from './mobile-nav';

const pathname = vi.hoisted(() => ({ current: '/threads/2' }));

vi.mock('next/navigation', () => ({ usePathname: () => pathname.current }));
vi.mock('next/link', () => ({
  default: ({ href, children, onClick, ...props }: ComponentProps<'a'> & { href: string }) => (
    <a
      href={href}
      onClick={(event) => {
        // Keep jsdom from attempting a real navigation.
        event.preventDefault();
        onClick?.(event);
      }}
      {...props}
    >
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

function renderMobileNav() {
  return render(
    <ThemeProvider>
      <MobileNav threads={THREADS} />
    </ThemeProvider>,
  );
}

beforeEach(() => {
  pathname.current = '/threads/2';
});

describe('MobileNav', () => {
  it('shows the current conversation title in the top bar', () => {
    renderMobileNav();

    expect(screen.getByRole('link', { name: /给独立开发者的账单工具/ })).toHaveAttribute(
      'href',
      '/threads/new',
    );
  });

  it('falls back to the product name off a conversation', () => {
    pathname.current = '/runs';
    renderMobileNav();

    expect(screen.getByRole('link', { name: /DemandX/ })).toBeVisible();
  });

  it('opens a drawer of conversations and closes it after navigating', async () => {
    const user = userEvent.setup();
    renderMobileNav();

    await user.click(screen.getByRole('button', { name: '打开导航' }));

    const drawer = await screen.findByRole('dialog', { name: '会话' });
    expect(within(drawer).getByRole('link', { name: /新建研究/ })).toHaveAttribute(
      'href',
      '/threads/new',
    );
    expect(within(drawer).getByRole('link', { name: /跨境库存同步工具/ })).toHaveAttribute(
      'href',
      '/threads/1',
    );
    expect(within(drawer).getByRole('link', { name: 'LLM 与采集' })).toBeVisible();

    for (const gone of ['工作台', '对话', '报告', '证据库']) {
      expect(within(drawer).queryByRole('link', { name: gone })).not.toBeInTheDocument();
    }

    await user.click(within(drawer).getByRole('link', { name: /跨境库存同步工具/ }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
});

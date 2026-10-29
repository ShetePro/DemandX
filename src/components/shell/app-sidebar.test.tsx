import { render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ThemeProvider } from '@/components/theme-provider';

import { AppSidebar } from './app-sidebar';

const pathname = vi.hoisted(() => ({ current: '/' }));

vi.mock('next/navigation', () => ({ usePathname: () => pathname.current }));

// Real `next/link` needs a mounted app router; an anchor is enough here.
vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: ComponentProps<'a'> & { href: string }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

function renderSidebar() {
  return render(
    <ThemeProvider>
      <AppSidebar />
    </ThemeProvider>,
  );
}

function navLink(name: string) {
  return screen.getByRole('link', { name });
}

beforeEach(() => {
  pathname.current = '/';
});

describe('AppSidebar', () => {
  it('exposes the brand, the primary action and every nav destination', () => {
    renderSidebar();

    expect(screen.getByText('需求验证工作台')).toBeVisible();
    expect(screen.getByRole('link', { name: /新建研究/ })).toHaveAttribute('href', '/threads/new');

    for (const name of ['工作台', '对话', '报告', '证据库']) {
      expect(navLink(name)).toBeVisible();
    }
    expect(navLink('LLM 与采集')).toHaveAttribute('href', '/settings');
  });

  it('marks only 工作台 as current on the root path', () => {
    renderSidebar();

    expect(navLink('工作台')).toHaveAttribute('aria-current', 'page');
    for (const name of ['对话', '报告', '证据库']) {
      expect(navLink(name)).not.toHaveAttribute('aria-current');
    }
  });

  it('marks 报告 as current on a run route', () => {
    pathname.current = '/runs/1';
    renderSidebar();

    expect(navLink('报告')).toHaveAttribute('aria-current', 'page');
    expect(navLink('证据库')).not.toHaveAttribute('aria-current');
    expect(navLink('工作台')).not.toHaveAttribute('aria-current');
  });

  it('marks 证据库 as current on a run evidence route, not 报告', () => {
    pathname.current = '/runs/1/evidence';
    renderSidebar();

    expect(navLink('证据库')).toHaveAttribute('aria-current', 'page');
    expect(navLink('报告')).not.toHaveAttribute('aria-current');
  });

  it('marks 对话 as current on a thread route', () => {
    pathname.current = '/threads/abc';
    renderSidebar();

    expect(navLink('对话')).toHaveAttribute('aria-current', 'page');
    expect(navLink('工作台')).not.toHaveAttribute('aria-current');
  });
});

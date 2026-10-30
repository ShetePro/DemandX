import { render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { ThreadTabs } from './thread-tabs';
import { parseThreadView } from './views';

const nav = vi.hoisted(() => ({
  pathname: '/threads/7',
  search: 'view=evidence&signal=paying',
}));

vi.mock('next/navigation', () => ({
  usePathname: () => nav.pathname,
  useSearchParams: () => new URLSearchParams(nav.search),
}));

// Real `next/link` needs a mounted app router; an anchor is enough here.
vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: ComponentProps<'a'> & { href: string }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

function tab(name: string) {
  return screen.getByRole('link', { name });
}

describe('ThreadTabs', () => {
  it('switches the view with the query only, keeping the other params', () => {
    render(<ThreadTabs view="evidence" />);

    expect(screen.getByRole('navigation', { name: '会话视图' })).toBeVisible();
    expect(tab('对话')).toHaveAttribute('href', '/threads/7?signal=paying');
    expect(tab('证据')).toHaveAttribute('href', '/threads/7?view=evidence&signal=paying');
    expect(tab('报告')).toHaveAttribute('href', '/threads/7?view=report&signal=paying');
    expect(tab('计划')).toHaveAttribute('href', '/threads/7?view=plan&signal=paying');

    expect(tab('证据')).toHaveAttribute('aria-current', 'page');
    for (const name of ['对话', '报告', '计划']) {
      expect(tab(name)).not.toHaveAttribute('aria-current');
    }
  });

  it('keeps the chat URL clean when no other param is set', () => {
    nav.search = '';
    render(<ThreadTabs view="chat" />);

    expect(tab('对话')).toHaveAttribute('href', '/threads/7');
    expect(tab('对话')).toHaveAttribute('aria-current', 'page');
    expect(tab('证据')).toHaveAttribute('href', '/threads/7?view=evidence');
    expect(tab('报告')).toHaveAttribute('href', '/threads/7?view=report');
    expect(tab('计划')).toHaveAttribute('href', '/threads/7?view=plan');
  });
});

describe('parseThreadView', () => {
  it('defaults to the conversation for anything unknown or absent', () => {
    expect(parseThreadView(undefined)).toBe('chat');
    expect(parseThreadView('')).toBe('chat');
    expect(parseThreadView('nope')).toBe('chat');
    expect(parseThreadView(['evidence', 'report'])).toBe('evidence');
    expect(parseThreadView('plan')).toBe('plan');
  });
});

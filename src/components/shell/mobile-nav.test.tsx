import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { ThemeProvider } from '@/components/theme-provider';

import { MobileNav } from './mobile-nav';

vi.mock('next/navigation', () => ({ usePathname: () => '/' }));
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

function renderMobileNav() {
  return render(
    <ThemeProvider>
      <MobileNav />
    </ThemeProvider>,
  );
}

describe('MobileNav', () => {
  it('opens the drawer from the menu button and closes it after navigating', async () => {
    const user = userEvent.setup();
    renderMobileNav();

    await user.click(screen.getByRole('button', { name: '打开导航' }));

    const drawer = await screen.findByRole('dialog', { name: '导航' });
    expect(within(drawer).getByRole('link', { name: '工作台' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    for (const name of ['对话', '报告', '证据库', 'LLM 与采集']) {
      expect(within(drawer).getByRole('link', { name })).toBeVisible();
    }

    await user.click(within(drawer).getByRole('link', { name: '报告' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('shows the current page title in the top bar', () => {
    renderMobileNav();

    expect(screen.getByRole('link', { name: /工作台/ })).toBeVisible();
  });
});

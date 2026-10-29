import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CommandPalette } from './command-palette';

const push = vi.hoisted(() => vi.fn());

vi.mock('next/navigation', () => ({ useRouter: () => ({ push }), usePathname: () => '/' }));

beforeEach(() => {
  push.mockClear();
});

describe('CommandPalette', () => {
  it('opens on mod+k and navigates to the single filtered match', async () => {
    const user = userEvent.setup();
    render(<CommandPalette />);

    expect(screen.queryByRole('dialog', { name: '命令面板' })).not.toBeInTheDocument();

    // jsdom reports no Apple platform, so `mod` resolves to Control.
    await user.keyboard('{Control>}k{/Control}');

    expect(await screen.findByRole('dialog', { name: '命令面板' })).toBeVisible();
    expect(screen.getByRole('option', { name: '工作台' })).toBeVisible();
    expect(screen.getByRole('option', { name: 'LLM 与采集' })).toBeVisible();

    await user.type(screen.getByRole('combobox'), '证据');

    expect(screen.queryByRole('option', { name: '工作台' })).not.toBeInTheDocument();
    expect(screen.getByRole('option', { name: '证据库' })).toBeVisible();

    await user.keyboard('{Enter}');

    expect(push).toHaveBeenCalledWith('/runs/latest/evidence');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('finds the settings entry by its Chinese keyword', async () => {
    const user = userEvent.setup();
    render(<CommandPalette />);

    await user.keyboard('{Control>}k{/Control}');
    await user.type(await screen.findByRole('combobox'), '设置');

    expect(screen.getByRole('option', { name: 'LLM 与采集' })).toBeVisible();

    await user.keyboard('{Enter}');
    expect(push).toHaveBeenCalledWith('/settings/llm');
  });

  it('returns focus to the element focused before opening', async () => {
    const user = userEvent.setup();
    render(<CommandPalette />);

    const trigger = document.createElement('button');
    trigger.textContent = '触发前';
    document.body.append(trigger);
    trigger.focus();

    await user.keyboard('{Control>}k{/Control}');
    expect(await screen.findByRole('dialog', { name: '命令面板' })).toBeVisible();

    await user.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
    trigger.remove();
  });
});

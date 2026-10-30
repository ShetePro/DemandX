import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ThreadSummaryRecord } from '@/lib/runs/repository';

import { CommandPalette } from './command-palette';

const push = vi.hoisted(() => vi.fn());

vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

beforeEach(() => {
  push.mockClear();
});

function thread(id: number, title: string): ThreadSummaryRecord {
  return {
    id,
    title,
    updatedAt: new Date('2026-10-30T10:00:00.000Z'),
    status: 'finished',
    stage: 'S6',
    score: 78,
    grade: 'B',
    decision: '建议先验证，再开发',
    hasReport: true,
  };
}

const THREADS: ThreadSummaryRecord[] = [
  thread(1, '跨境库存同步工具'),
  thread(2, '给独立开发者的账单工具'),
];

describe('CommandPalette', () => {
  it('offers the commands and the conversations, and navigates to the match', async () => {
    const user = userEvent.setup();
    render(<CommandPalette threads={THREADS} />);

    expect(screen.queryByRole('dialog', { name: '命令面板' })).not.toBeInTheDocument();

    // jsdom reports no Apple platform, so `mod` resolves to Control.
    await user.keyboard('{Control>}k{/Control}');

    expect(await screen.findByRole('dialog', { name: '命令面板' })).toBeVisible();
    expect(screen.getByRole('option', { name: '新建研究' })).toBeVisible();
    expect(screen.getByRole('option', { name: '设置' })).toBeVisible();
    expect(screen.getByRole('option', { name: /跨境库存同步工具/ })).toBeVisible();

    await user.type(screen.getByRole('combobox'), '账单');

    expect(screen.queryByRole('option', { name: /跨境库存同步工具/ })).not.toBeInTheDocument();
    expect(screen.getByRole('option', { name: /给独立开发者的账单工具/ })).toBeVisible();

    await user.keyboard('{Enter}');

    expect(push).toHaveBeenCalledWith('/threads/2');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('opens the new-research screen from the command', async () => {
    const user = userEvent.setup();
    render(<CommandPalette threads={THREADS} />);

    await user.keyboard('{Control>}k{/Control}');
    await user.type(await screen.findByRole('combobox'), '新建');

    await user.keyboard('{Enter}');

    expect(push).toHaveBeenCalledWith('/threads/new');
  });

  it('finds the settings command by a keyword its label does not contain', async () => {
    const user = userEvent.setup();
    render(<CommandPalette threads={THREADS} />);

    await user.keyboard('{Control>}k{/Control}');
    await user.type(await screen.findByRole('combobox'), 'llm');

    expect(screen.getByRole('option', { name: '设置' })).toBeVisible();

    await user.keyboard('{Enter}');
    expect(push).toHaveBeenCalledWith('/settings/llm');
  });

  it('stops at the 20 most recent conversations', async () => {
    const user = userEvent.setup();
    const many = Array.from({ length: 25 }, (_, index) => thread(index + 1, `会话 ${index + 1}`));
    render(<CommandPalette threads={many} />);

    await user.keyboard('{Control>}k{/Control}');
    const list = await screen.findByRole('listbox');

    expect(screen.getByRole('option', { name: /会话 20/ })).toBeVisible();
    expect(screen.queryByRole('option', { name: /会话 21/ })).not.toBeInTheDocument();
    expect(list).toBeVisible();
  });

  it('returns focus to the element focused before opening', async () => {
    const user = userEvent.setup();
    render(<CommandPalette threads={THREADS} />);

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

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ThreadSummaryRecord } from '@/lib/runs/repository';

import { ThreadList } from './thread-list';

const pathname = vi.hoisted(() => ({ current: '/threads/2' }));

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));

vi.mock('next/navigation', () => ({
  usePathname: () => pathname.current,
  useRouter: () => router,
}));

const onDelete = vi.hoisted(() => vi.fn());

// Real `next/link` needs a mounted app router; an anchor is enough here.
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
  {
    id: 3,
    title: '还没有开始的对话',
    updatedAt: new Date('2026-10-29T09:00:00.000Z'),
    status: 'not_started',
    stage: null,
    score: null,
    grade: null,
    decision: null,
    hasReport: false,
  },
];

function row(title: string): HTMLElement {
  return screen.getByRole('link', { name: new RegExp(title) });
}

beforeEach(() => {
  pathname.current = '/threads/2';
  onDelete.mockReset();
  router.push.mockReset();
  router.refresh.mockReset();
});

describe('ThreadList', () => {
  it('lists one row per conversation, with its status and report score', () => {
    render(<ThreadList threads={THREADS} onDelete={onDelete} />);

    expect(screen.getByRole('navigation', { name: '会话列表' })).toBeVisible();
    expect(screen.getAllByRole('link')).toHaveLength(3);

    expect(row('跨境库存同步工具')).toHaveAttribute('href', '/threads/1');
    expect(row('跨境库存同步工具')).toHaveTextContent('进行中 · S2 抽取');

    expect(row('给独立开发者的账单工具')).toHaveTextContent('78 · B');
    expect(row('给独立开发者的账单工具')).toHaveTextContent('已完成');

    expect(row('还没有开始的对话')).toHaveTextContent('未开始');
    expect(row('还没有开始的对话')).not.toHaveTextContent('·');
  });

  it('marks the conversation in the URL as current, and only that one', () => {
    render(<ThreadList threads={THREADS} onDelete={onDelete} />);

    expect(row('给独立开发者的账单工具')).toHaveAttribute('aria-current', 'page');
    expect(row('给独立开发者的账单工具')).toHaveClass('bg-accent-soft');

    expect(row('跨境库存同步工具')).not.toHaveAttribute('aria-current');
    expect(row('还没有开始的对话')).not.toHaveAttribute('aria-current');
  });

  it('shows no current row on any other page', () => {
    pathname.current = '/runs';
    render(<ThreadList threads={THREADS} onDelete={onDelete} />);

    for (const thread of THREADS) expect(row(thread.title)).not.toHaveAttribute('aria-current');
  });

  it('keeps the stage out of the compact drawer row', () => {
    render(<ThreadList threads={THREADS} onDelete={onDelete} compact />);

    expect(row('跨境库存同步工具')).toHaveTextContent('进行中');
    expect(row('跨境库存同步工具')).not.toHaveTextContent('S2 抽取');
  });

  it('invites a first research when the database has no conversations', () => {
    render(<ThreadList threads={[]} onDelete={onDelete} />);

    expect(screen.getByText('还没有会话，点上方新建研究')).toBeVisible();
    expect(screen.queryAllByRole('link')).toHaveLength(0);
  });

  it('reveals a per-row action button that opens the menu', async () => {
    const user = userEvent.setup();
    render(<ThreadList threads={THREADS} onDelete={onDelete} />);

    const trigger = screen.getByRole('button', { name: '会话操作：跨境库存同步工具' });
    expect(trigger).toHaveClass('opacity-0');

    await user.click(trigger);

    expect(await screen.findByRole('menu')).toBeVisible();
    expect(screen.getByRole('menuitem', { name: '删除会话' })).toBeVisible();
  });

  it('opens the same menu on right-click', async () => {
    render(<ThreadList threads={THREADS} onDelete={onDelete} />);

    const rowElement = row('跨境库存同步工具');
    fireEvent.contextMenu(rowElement);

    expect(await screen.findByRole('menu')).toBeVisible();
    expect(screen.getByRole('menuitem', { name: '删除会话' })).toBeVisible();
  });

  it('deletes after confirmation, then refreshes and leaves the active thread', async () => {
    const user = userEvent.setup();
    onDelete.mockResolvedValue({ ok: true, value: { threadId: 2, ideaDeleted: true } });
    render(<ThreadList threads={THREADS} onDelete={onDelete} />);

    await user.click(screen.getByRole('button', { name: '会话操作：给独立开发者的账单工具' }));
    await user.click(await screen.findByRole('menuitem', { name: '删除会话' }));

    expect(screen.getByRole('dialog')).toBeVisible();
    await user.click(screen.getByRole('button', { name: '删除' }));

    await waitFor(() => expect(onDelete).toHaveBeenCalledWith(2));
    expect(router.push).toHaveBeenCalledWith('/threads/new');
    expect(router.refresh).toHaveBeenCalled();
  });

  it('keeps the row and reports the error when deletion fails', async () => {
    const user = userEvent.setup();
    onDelete.mockResolvedValue({
      ok: false,
      code: 'STORAGE_FAILED',
      message: '删除会话失败 (SQLSTATE 08006)',
    });
    render(<ThreadList threads={THREADS} onDelete={onDelete} />);

    await user.click(screen.getByRole('button', { name: '会话操作：给独立开发者的账单工具' }));
    await user.click(await screen.findByRole('menuitem', { name: '删除会话' }));
    await user.click(screen.getByRole('button', { name: '删除' }));

    await waitFor(() => expect(onDelete).toHaveBeenCalledWith(2));
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it('notifies the drawer after a row is activated', async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    render(<ThreadList threads={THREADS} onDelete={onDelete} onNavigate={onNavigate} />);

    await user.click(row('跨境库存同步工具'));

    expect(onNavigate).toHaveBeenCalledTimes(1);
  });
});

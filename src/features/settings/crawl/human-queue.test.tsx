import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { NeedsHumanItem } from '@/lib/runs/human-queue';

import { HumanQueue } from './human-queue';

const mocks = vi.hoisted(() => ({
  retryRunAction: vi.fn(),
  refresh: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock('./actions', () => ({
  retryRunAction: mocks.retryRunAction,
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: mocks.refresh }),
}));

vi.mock('sonner', () => ({
  toast: { success: mocks.success, error: mocks.error },
}));

const ITEM: NeedsHumanItem = {
  eventId: 12,
  runId: 7,
  url: 'https://www.xiaohongshu.com/explore/abc',
  platform: 'xiaohongshu',
  reason: 'login',
  createdAt: new Date('2026-10-30T08:00:00.000Z'),
  runStatus: 'finished',
  runStage: 'S1',
};

beforeEach(() => {
  mocks.retryRunAction.mockReset();
  mocks.refresh.mockReset();
  mocks.success.mockReset();
  mocks.error.mockReset();
});

describe('HumanQueue', () => {
  it('renders the blocked page, its reason and its run', () => {
    render(<HumanQueue items={[ITEM]} />);

    expect(screen.getByText('https://www.xiaohongshu.com/explore/abc')).toBeInTheDocument();
    expect(screen.getByText('需要登录')).toBeInTheDocument();
    expect(screen.getByText(/run 7/)).toBeInTheDocument();
  });

  it('re-enqueues the run when retry is clicked', async () => {
    mocks.retryRunAction.mockResolvedValue({ ok: true, value: { jobId: 'job-1' } });
    const user = userEvent.setup();
    render(<HumanQueue items={[ITEM]} />);

    await user.click(screen.getByRole('button', { name: '重试' }));

    await waitFor(() => expect(mocks.retryRunAction).toHaveBeenCalledWith(7));
    await waitFor(() => expect(mocks.success).toHaveBeenCalledWith('已重新入队 run 7'));
    expect(mocks.refresh).toHaveBeenCalled();
  });

  it('surfaces a failed enqueue without refreshing', async () => {
    mocks.retryRunAction.mockResolvedValue({
      ok: false,
      code: 'STORAGE_FAILED',
      message: 'S1 入队失败: connection refused',
    });
    const user = userEvent.setup();
    render(<HumanQueue items={[ITEM]} />);

    await user.click(screen.getByRole('button', { name: '重试' }));

    await waitFor(() =>
      expect(mocks.error).toHaveBeenCalledWith('S1 入队失败: connection refused'),
    );
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it('renders an empty state instead of a bare heading', () => {
    render(<HumanQueue items={[]} />);

    expect(screen.getByText('暂无待处理页面。')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '重试' })).not.toBeInTheDocument();
  });
});

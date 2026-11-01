import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { DiscoveryResult } from '@/lib/discovery/types';

import { OpportunityFinder } from './opportunity-finder';

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));

/**
 * The project's TS lib predates `Promise.withResolvers`, so the executor form
 * is the only way to keep a resolver from a pending promise.
 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

vi.mock('next/navigation', () => ({ useRouter: () => router }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

const RESULT: DiscoveryResult = {
  providers: ['ddg', 'bing'],
  sources: [
    {
      url: 'https://example.com/post-1',
      title: '帖子',
      snippet: '每天手工同步库存太麻烦',
      platform: 'web',
    },
  ],
  opportunities: [
    {
      title: '跨境库存同步',
      problem: '卖家在三个平台之间手工同步库存，经常超卖',
      audience: '跨境小卖家',
      signal: 'problem',
      evidence: [{ url: 'https://example.com/post-1', quote: '每天手工同步太麻烦' }],
    },
  ],
};

beforeEach(() => {
  router.push.mockReset();
  router.refresh.mockReset();
});

describe('OpportunityFinder', () => {
  it('opens the radar and shows the scan while the action is pending', async () => {
    const user = userEvent.setup();
    const pending = deferred<{ ok: true; value: DiscoveryResult }>();
    const onFind = vi.fn(() => pending.promise);
    render(<OpportunityFinder onFind={onFind} onStart={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: '寻找机会' }));

    expect(onFind).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('dialog', { name: '机会雷达' })).toBeVisible();
    expect(screen.getByText(/正在检索/)).toBeVisible();

    pending.resolve({ ok: true, value: RESULT });
    expect(await screen.findByText('跨境库存同步')).toBeVisible();
    expect(screen.getByText(/每天手工同步太麻烦/)).toBeVisible();
    expect(screen.getByText(/已分析 1 条公开片段/)).toBeVisible();
  });

  it('starts a research thread from a discovered opportunity', async () => {
    const user = userEvent.setup();
    const onStart = vi.fn(async () => ({ ok: true as const, value: { threadId: 42 } }));
    render(
      <OpportunityFinder onFind={async () => ({ ok: true, value: RESULT })} onStart={onStart} />,
    );

    await user.click(screen.getByRole('button', { name: '寻找机会' }));
    await user.click(await screen.findByRole('button', { name: '用它开始研究' }));

    await waitFor(() => expect(onStart).toHaveBeenCalledTimes(1));
    expect(onStart).toHaveBeenCalledWith(expect.stringContaining('跨境库存同步'));
    expect(onStart).toHaveBeenCalledWith(expect.stringContaining('手工同步库存'));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith('/threads/42'));
  });

  it('shows the failure and offers a retry', async () => {
    const user = userEvent.setup();
    const onFind = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, code: 'NO_SOURCES', message: '搜索源全部失败' })
      .mockResolvedValueOnce({ ok: true, value: RESULT });
    render(<OpportunityFinder onFind={onFind} onStart={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: '寻找机会' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('搜索源全部失败');

    await user.click(screen.getByRole('button', { name: '重新扫描' }));
    expect(await screen.findByText('跨境库存同步')).toBeVisible();
    expect(onFind).toHaveBeenCalledTimes(2);
  });
});

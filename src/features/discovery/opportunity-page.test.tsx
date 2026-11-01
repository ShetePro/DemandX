import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { DiscoveryResult } from '@/lib/discovery/types';

import { OpportunityPage } from './opportunity-page';
import type { ScanPhase } from './stream';

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));

vi.mock('next/navigation', () => ({ useRouter: () => router }));
// The real actions open a database client at import time; every test passes its
// own `find` / `start`, so the module only has to exist.
vi.mock('./actions', () => ({
  findOpportunitiesAction: vi.fn(),
  startDiscoveredResearchAction: vi.fn(),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

/** This TS lib predates `Promise.withResolvers`; keep the resolver here. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const RESULT: DiscoveryResult = {
  providers: ['ddg', 'bing'],
  elapsedMs: 16_600,
  model: 'glm-5.3-flash',
  sources: [
    {
      url: 'https://example.com/post-1',
      title: '小店主的吐槽',
      snippet: '愿意付费买一个库存同步工具',
      platform: 'web',
    },
    {
      url: 'https://example.com/post-2',
      title: '对比帖',
      snippet: '三个工具的定价对比',
      platform: 'web',
    },
  ],
  opportunities: [
    {
      title: '跨境库存同步',
      problem: '卖家在三个平台之间手工同步库存，经常超卖',
      audience: '跨境小卖家',
      signal: 'problem',
      currentAlternative: '每天手工复制三个平台的表格',
      competitors: ['库存同步助手'],
      monetization: 'subscription',
      mvp: '两个平台的库存拉取与超卖提醒',
      evidence: [{ url: 'https://example.com/post-1', quote: '愿意付费买一个工具' }],
    },
  ],
};

beforeEach(() => {
  router.push.mockReset();
  router.refresh.mockReset();
});

describe('OpportunityPage', () => {
  it('scans on mount, then shows timings, provenance and opportunities', async () => {
    const pending = deferred<{ ok: true; value: DiscoveryResult }>();
    const find = vi.fn(() => pending.promise);
    render(<OpportunityPage find={find} start={vi.fn()} />);

    await waitFor(() => expect(find).toHaveBeenCalledTimes(1));
    expect(screen.getByText('正在扫描')).toBeVisible();
    expect(screen.getByText(/检索中英文公开片段/)).toBeVisible();

    pending.resolve({ ok: true, value: RESULT });

    expect(await screen.findByText('跨境库存同步')).toBeVisible();
    expect(screen.getByText('16.6s')).toBeVisible();
    expect(screen.getByText('glm-5.3-flash')).toBeVisible();
    expect(screen.getByText('ddg · bing')).toBeVisible();
    expect(screen.getByText('“愿意付费买一个工具”')).toBeVisible();
    expect(screen.getByText('每天手工复制三个平台的表格')).toBeVisible();
    expect(screen.getByText('订阅')).toBeVisible();
    expect(screen.getByText('两个平台的库存拉取与超卖提醒')).toBeVisible();
    expect(screen.getByText('查看本次扫描的 2 条原始片段')).toBeVisible();
  });

  it('starts a research thread from a card', async () => {
    const user = userEvent.setup();
    const start = vi.fn(async () => ({ ok: true as const, value: { threadId: 42 } }));
    render(<OpportunityPage find={async () => ({ ok: true, value: RESULT })} start={start} />);

    await user.click(await screen.findByRole('button', { name: '用它开始研究' }));

    await waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    expect(start).toHaveBeenCalledWith(expect.stringContaining('跨境库存同步'));
    expect(start).toHaveBeenCalledWith(expect.stringContaining('手工同步库存'));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith('/threads/42'));
  });

  it('reports a failed scan and rescans on demand', async () => {
    const user = userEvent.setup();
    const find = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, code: 'NO_SOURCES', message: '搜索源全部失败' })
      .mockResolvedValueOnce({ ok: true, value: RESULT });
    render(<OpportunityPage find={find} start={vi.fn()} />);

    expect(await screen.findByRole('alert')).toHaveTextContent('搜索源全部失败');
    await user.click(screen.getByRole('button', { name: '重新扫描' }));

    expect(await screen.findByText('跨境库存同步')).toBeVisible();
    expect(find).toHaveBeenCalledTimes(2);
  });

  it('excludes sources from earlier scans when rescanning', async () => {
    const user = userEvent.setup();
    const find = vi.fn(
      async (_excludeUrls: readonly string[], _onPhase: (phase: ScanPhase) => void) => {
        void _excludeUrls;
        void _onPhase;
        return { ok: true as const, value: RESULT };
      },
    );
    render(<OpportunityPage find={find} start={vi.fn()} />);

    await screen.findByText('跨境库存同步');
    expect(find.mock.calls.at(-1)?.[0]).toEqual([]);

    await user.click(screen.getByRole('button', { name: '再扫一轮' }));
    await waitFor(() => expect(find).toHaveBeenCalledTimes(2));
    expect(find.mock.calls.at(-1)?.[0]).toEqual(
      expect.arrayContaining(['https://example.com/post-1', 'https://example.com/post-2']),
    );
  });

  it('marks search as done and filtering as active when the phase advances', async () => {
    const pending = deferred<{ ok: true; value: DiscoveryResult }>();
    const find = vi.fn(
      async (_excludeUrls: readonly string[], onPhase: (phase: ScanPhase) => void) => {
        onPhase('search');
        onPhase('filter');
        return pending.promise;
      },
    );
    render(<OpportunityPage find={find} start={vi.fn()} />);

    const searchStep = (await screen.findByText('检索中英文公开片段')).closest('li');
    const filterStep = screen.getByText('过滤内容农场与无商业线索页面').closest('li');
    const modelStep = screen.getByText('模型筛选可落地的方向').closest('li');

    await waitFor(() => expect(searchStep).toHaveAttribute('data-done', 'true'));
    expect(filterStep).toHaveAttribute('aria-current', 'step');
    expect(modelStep).not.toHaveAttribute('aria-current');

    pending.resolve({ ok: true, value: RESULT });
    expect(await screen.findByText('跨境库存同步')).toBeVisible();
  });
});

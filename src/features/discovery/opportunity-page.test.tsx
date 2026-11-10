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
  scanId: 91,
  angles: ['跨境库存', '小店主财务'],
  rationale: '最近热点集中在库存同步与手工对账。',
  strategy: 'planned',
  commercialGap: false,
  novelty: { newUrls: 2, total: 2, ratio: 1 },
  avoided: 0,
  queries: ['跨境 库存 同步', 'invoice reconciliation spreadsheet'],
  socialQueries: [{ platform: 'zhihu', query: '跨境 库存' }],
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
      angle: '跨境库存',
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
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({
        idea: expect.stringContaining('跨境库存同步'),
        scanId: 91,
        title: '跨境库存同步',
        angle: '跨境库存',
      }),
    );
    await waitFor(() => expect(router.push).toHaveBeenCalledWith('/threads/42'));
  });

  it('keeps earlier rounds and appends the next one under a skeleton', async () => {
    const user = userEvent.setup();
    const pending = deferred<{ ok: true; value: DiscoveryResult }>();
    const second: DiscoveryResult = {
      ...RESULT,
      scanId: 92,
      angles: ['诊所排班'],
      opportunities: [
        {
          ...RESULT.opportunities[0]!,
          title: '诊所排班助手',
          angle: '诊所排班',
        },
      ],
    };
    const find = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, value: RESULT })
      .mockReturnValueOnce(pending.promise);

    render(<OpportunityPage find={find} start={vi.fn()} />);
    expect(await screen.findByText('跨境库存同步')).toBeVisible();

    await user.click(screen.getByRole('button', { name: '再扫一轮' }));

    // The finished round stays readable while the new one loads.
    expect(screen.getByText('跨境库存同步')).toBeVisible();
    expect(screen.getByRole('status', { name: '第 2 轮扫描中' })).toBeVisible();
    expect(screen.getByText('新一轮结果会追加在下方，之前的扫描不会被清除。')).toBeVisible();

    pending.resolve({ ok: true, value: second });

    expect(await screen.findByText('诊所排班助手')).toBeVisible();
    expect(screen.getByText('跨境库存同步')).toBeVisible();
    expect(screen.queryByRole('status', { name: '第 2 轮扫描中' })).toBeNull();
    expect(screen.getByText('第 1 轮')).toBeVisible();
    expect(screen.getByText('第 2 轮')).toBeVisible();
  });

  it('keeps earlier rounds when a rescan fails', async () => {
    const user = userEvent.setup();
    const find = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, value: RESULT })
      .mockResolvedValueOnce({ ok: false, code: 'NO_SOURCES', message: '这一轮太薄' });

    render(<OpportunityPage find={find} start={vi.fn()} />);
    expect(await screen.findByText('跨境库存同步')).toBeVisible();

    await user.click(screen.getByRole('button', { name: '再扫一轮' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('这一轮太薄');
    expect(screen.getByText('跨境库存同步')).toBeVisible();
    expect(screen.getByRole('button', { name: '再试一次' })).toBeVisible();
  });

  it('offers the same rescan action at the bottom of the list', async () => {
    const user = userEvent.setup();
    const pending = deferred<{ ok: true; value: DiscoveryResult }>();
    const find = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, value: RESULT })
      .mockReturnValueOnce(pending.promise);
    render(<OpportunityPage find={find} start={vi.fn()} />);

    expect(await screen.findByText('跨境库存同步')).toBeVisible();

    const bottom = screen.getByRole('button', { name: '再扫一轮（列表底部）' });
    expect(bottom).toBeVisible();

    await user.click(bottom);

    await waitFor(() => expect(find).toHaveBeenCalledTimes(2));
    expect(screen.getByText('跨境库存同步')).toBeVisible();
    expect(screen.getByRole('status', { name: '第 2 轮扫描中' })).toBeVisible();
  });

  it('sends the operator-picked directions with the next scan', async () => {
    const user = userEvent.setup();
    const pending = deferred<{ ok: true; value: DiscoveryResult }>();
    const find = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, value: RESULT })
      .mockReturnValueOnce(pending.promise);

    render(<OpportunityPage find={find} start={vi.fn()} />);
    expect(await screen.findByText('跨境库存同步')).toBeVisible();

    await user.type(screen.getByLabelText('添加扫描方向'), '诊所排班{Enter}');
    expect(screen.getByText('诊所排班')).toBeVisible();

    await user.click(screen.getByRole('button', { name: '再扫一轮（列表底部）' }));

    await waitFor(() => expect(find).toHaveBeenCalledTimes(2));
    expect(find.mock.calls.at(-1)?.[1]).toEqual(['诊所排班']);
  });

  it('removes a picked direction', async () => {
    const user = userEvent.setup();
    const find = vi.fn().mockResolvedValueOnce({ ok: true, value: RESULT });
    render(<OpportunityPage find={find} start={vi.fn()} />);
    expect(await screen.findByText('跨境库存同步')).toBeVisible();

    await user.type(screen.getByLabelText('添加扫描方向'), '诊所排班{Enter}');
    await user.click(screen.getByRole('button', { name: '移除方向 诊所排班' }));

    expect(screen.queryByText('诊所排班')).toBeNull();
  });

  it('warns when a round had no paid signal but still shows its ideas', async () => {
    const gap: DiscoveryResult = { ...RESULT, commercialGap: true };
    render(<OpportunityPage find={async () => ({ ok: true, value: gap })} start={vi.fn()} />);

    expect(await screen.findByText('跨境库存同步')).toBeVisible();
    expect(
      screen.getByText(
        '本轮没有可引用的付费/商业线索：以下方向只基于问题信号，开始研究前需补证据',
      ),
    ).toBeVisible();
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
      async (
        _excludeUrls: readonly string[],
        _directions: readonly string[],
        _onPhase: (phase: ScanPhase) => void,
      ) => {
        void _excludeUrls;
        void _directions;
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

  it('marks planning as done and searching as active when the phase advances', async () => {
    const pending = deferred<{ ok: true; value: DiscoveryResult }>();
    const find = vi.fn(
      async (
        _excludeUrls: readonly string[],
        _directions: readonly string[],
        onPhase: (phase: ScanPhase) => void,
      ) => {
        onPhase('plan');
        onPhase('search');
        onPhase('filter');
        return pending.promise;
      },
    );
    render(<OpportunityPage find={find} start={vi.fn()} />);

    const planStep = (await screen.findByText('按最近热点与历史扫描规划新角度')).closest('li');
    const searchStep = screen.getByText('检索中英文公开片段').closest('li');
    const filterStep = screen.getByText('过滤内容农场与无商业线索页面').closest('li');
    const modelStep = screen.getByText('模型筛选可落地的方向').closest('li');

    await waitFor(() => expect(planStep).toHaveAttribute('data-done', 'true'));
    expect(searchStep).toHaveAttribute('data-done', 'true');
    expect(filterStep).toHaveAttribute('aria-current', 'step');
    expect(modelStep).not.toHaveAttribute('aria-current');

    pending.resolve({ ok: true, value: RESULT });
    expect(await screen.findByText('跨境库存同步')).toBeVisible();
  });
});

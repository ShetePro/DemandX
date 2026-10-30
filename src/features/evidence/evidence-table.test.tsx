import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { EvidenceTable } from './evidence-table';
import type { EvidenceFilterState, EvidenceViewItem } from './types';

const mocks = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn(), onOpen: vi.fn() }));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mocks.push, refresh: mocks.refresh }),
  usePathname: () => '/runs/7/evidence',
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('./actions', () => ({
  rejectEvidenceAction: vi.fn(),
  restoreEvidenceAction: vi.fn(),
}));

const ACCEPTED: EvidenceViewItem = {
  id: 1,
  runId: 7,
  quote:
    '我在三个平台之间手工同步库存，每天要花三个小时，旺季更久，已经持续半年了。另外还要对账、处理退款和缺货，每周至少一整天。'.repeat(
      2,
    ),
  quoteOffset: 10,
  platform: 'xiaohongshu',
  publishedAt: new Date('2026-03-11T00:00:00.000Z'),
  signal: 'problem',
  firstHand: true,
  priceMentioned: null,
  supports: '作者描述自己的库存同步问题',
  doesNotProve: '不能证明这个问题有多普遍',
  rejectedReason: null,
  createdAt: new Date('2026-10-29T00:00:00.000Z'),
  sourceUrl: 'https://www.xiaohongshu.com/explore/abc',
  contentHash: 'a'.repeat(64),
  highlight: { before: '旺季：', quote: '我在三个平台之间手工同步库存', after: '，非常耗时。' },
};

const REJECTED: EvidenceViewItem = {
  ...ACCEPTED,
  id: 2,
  quote: '多平台库存同步非常麻烦',
  rejectedReason: 'quote_not_in_snapshot',
  highlight: null,
};

const FILTERS = { signal: null, platform: null, status: null, q: null } as const;

beforeEach(() => {
  mocks.push.mockReset();
  mocks.refresh.mockReset();
  mocks.onOpen.mockReset();
});

function renderTable(
  items: EvidenceViewItem[] = [ACCEPTED, REJECTED],
  filters: EvidenceFilterState = FILTERS,
) {
  return render(
    <EvidenceTable
      items={items}
      counts={{ accepted: 1, rejected: 1 }}
      filters={filters}
      platforms={['reddit', 'xiaohongshu']}
      onOpen={mocks.onOpen}
    />,
  );
}

describe('EvidenceTable', () => {
  it('pushes every filter into the URL and keeps the previous ones', async () => {
    const user = userEvent.setup();
    const view = renderTable();

    await user.click(screen.getByRole('button', { name: '付费' }));
    expect(mocks.push).toHaveBeenLastCalledWith('/runs/7/evidence?signal=paying');

    // The RSC re-renders with the parsed URL after each navigation.
    const withSignal = { ...FILTERS, signal: 'paying' } satisfies EvidenceFilterState;
    view.rerender(
      <EvidenceTable
        items={[ACCEPTED, REJECTED]}
        counts={{ accepted: 1, rejected: 1 }}
        filters={withSignal}
        platforms={['reddit', 'xiaohongshu']}
        onOpen={mocks.onOpen}
      />,
    );

    await user.selectOptions(screen.getByLabelText('平台'), 'reddit');
    expect(mocks.push).toHaveBeenLastCalledWith('/runs/7/evidence?signal=paying&platform=reddit');

    const withPlatform = { ...withSignal, platform: 'reddit' } satisfies EvidenceFilterState;
    view.rerender(
      <EvidenceTable
        items={[ACCEPTED, REJECTED]}
        counts={{ accepted: 1, rejected: 1 }}
        filters={withPlatform}
        platforms={['reddit', 'xiaohongshu']}
        onOpen={mocks.onOpen}
      />,
    );

    await user.selectOptions(screen.getByLabelText('状态'), 'rejected');
    expect(mocks.push).toHaveBeenLastCalledWith(
      '/runs/7/evidence?signal=paying&platform=reddit&status=rejected',
    );

    const withStatus = { ...withPlatform, status: 'rejected' } satisfies EvidenceFilterState;
    view.rerender(
      <EvidenceTable
        items={[ACCEPTED, REJECTED]}
        counts={{ accepted: 1, rejected: 1 }}
        filters={withStatus}
        platforms={['reddit', 'xiaohongshu']}
        onOpen={mocks.onOpen}
      />,
    );

    await user.type(screen.getByRole('textbox', { name: '搜索证据' }), '库存');
    await user.click(screen.getByRole('button', { name: '搜索' }));
    expect(mocks.push).toHaveBeenLastCalledWith(
      '/runs/7/evidence?signal=paying&platform=reddit&status=rejected&q=%E5%BA%93%E5%AD%98',
    );
  });

  it('opens the row drawer from a click and from the keyboard', async () => {
    const user = userEvent.setup();
    renderTable();

    await user.click(screen.getByRole('button', { name: '查看证据 1' }));
    expect(mocks.onOpen).toHaveBeenCalledWith(ACCEPTED);
    expect(screen.getByRole('heading', { name: '证据 #1' })).toBeVisible();

    mocks.onOpen.mockReset();
    await user.click(screen.getByRole('button', { name: '关闭' }));

    screen.getByRole('button', { name: '查看证据 2' }).focus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(mocks.onOpen).toHaveBeenCalledWith(REJECTED));
  });

  it('shows accepted and rejected state with the rejection reason', () => {
    renderTable();

    expect(screen.getAllByText('有效').length).toBeGreaterThan(0);
    const table = screen.getByRole('table');
    expect(within(table).getByText('已驳回')).toBeVisible();
    expect(within(table).getByText('引文不在快照中')).toBeVisible();
    expect(screen.getByText('摘要')).toBeVisible();
  });

  it('truncates long summaries and renders an empty state', () => {
    const { rerender } = renderTable([ACCEPTED]);

    expect(screen.getByText(/…$/)).toBeInTheDocument();

    rerender(
      <EvidenceTable
        items={[]}
        counts={{ accepted: 0, rejected: 0 }}
        filters={FILTERS}
        platforms={[]}
      />,
    );
    expect(screen.getByText('没有符合条件的证据。')).toBeVisible();
  });
});

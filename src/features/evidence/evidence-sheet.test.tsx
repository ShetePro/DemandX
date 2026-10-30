import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { EvidenceSheet } from './evidence-sheet';
import type { EvidenceViewItem } from './types';

vi.mock('./actions', () => ({
  rejectEvidenceAction: vi.fn(),
  restoreEvidenceAction: vi.fn(),
}));

const BASE: EvidenceViewItem = {
  id: 12,
  runId: 7,
  quote: '我在三个平台之间手工同步库存',
  quoteOffset: 100,
  platform: 'xiaohongshu',
  publishedAt: new Date('2026-03-11T00:00:00.000Z'),
  signal: 'problem',
  firstHand: true,
  priceMentioned: { amount: 99, currency: 'USD' },
  supports: '作者在描述自己的库存同步问题',
  doesNotProve: '不能证明这个问题有多普遍',
  rejectedReason: null,
  createdAt: new Date('2026-10-30T00:00:00.000Z'),
  sourceUrl: 'https://www.xiaohongshu.com/explore/abc',
  contentHash: 'a'.repeat(64),
  highlight: {
    before: '旺季每天：',
    quote: '我在三个平台之间手工同步库存',
    after: '，非常耗时。',
  },
};

describe('EvidenceSheet', () => {
  it('renders the quote inside a mark using the server-cut fragments', () => {
    render(<EvidenceSheet item={BASE} onClose={vi.fn()} onChanged={vi.fn()} />);

    const mark = document.querySelector('mark');
    expect(mark).not.toBeNull();
    expect(mark).toHaveTextContent('我在三个平台之间手工同步库存');
    expect(screen.getByText(/旺季每天/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /打开原文链接/ })).toHaveAttribute(
      'href',
      BASE.sourceUrl,
    );
    expect(screen.getByRole('button', { name: '驳回' })).toBeVisible();
    expect(screen.queryByRole('button', { name: '恢复为有效' })).not.toBeInTheDocument();
  });

  it('shows the rejection reason and offers a restore button', () => {
    render(
      <EvidenceSheet
        item={{ ...BASE, rejectedReason: 'manual', highlight: null }}
        onClose={vi.fn()}
        onChanged={vi.fn()}
      />,
    );

    expect(screen.getByText('已驳回')).toBeVisible();
    expect(screen.getByText(/人工驳回（manual）/)).toBeVisible();
    expect(screen.getByRole('button', { name: '恢复为有效' })).toBeVisible();
    expect(screen.queryByRole('button', { name: '驳回' })).not.toBeInTheDocument();
  });

  it('degrades to a plain quote when the snapshot was missing', () => {
    render(
      <EvidenceSheet item={{ ...BASE, highlight: null }} onClose={vi.fn()} onChanged={vi.fn()} />,
    );

    expect(screen.getByText('快照缺失，无法高亮，仅显示已存引文。')).toBeVisible();
    expect(screen.getByText('我在三个平台之间手工同步库存')).toBeVisible();
    expect(document.querySelector('mark')).toBeNull();
  });
});

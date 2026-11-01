import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { ReportEvidenceItem, ReportRecord } from '@/lib/report/read';
import { REPORT_SECTIONS, type ReportSectionBody } from '@/lib/report/validate';

import { exportReportAction } from './export-action';
import { ReportView } from './report-view';

vi.mock('./export-action', () => ({ exportReportAction: vi.fn() }));

vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: ComponentProps<'a'> & { href: string }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

function body(text = '一条有引用的论断', evidenceIds = [12]): ReportSectionBody {
  return { claims: [{ text, evidenceIds }], unknowns: [] };
}

function sections(
  overrides: Record<string, ReportSectionBody> = {},
): Record<string, ReportSectionBody> {
  const base: Record<string, ReportSectionBody> = {};
  for (const section of REPORT_SECTIONS) base[section] = body(`${section} 的论断`);
  return { ...base, ...overrides };
}

const E12: ReportEvidenceItem = {
  id: 12,
  quote: '每天手工对账三小时',
  platform: '小红书',
  publishedAt: new Date(2026, 1, 18),
  signal: 'problem',
  firstHand: true,
  supports: '确实存在手工同步问题',
  doesNotProve: '不能证明用户愿意付费',
  rejectedReason: null,
  sourceUrl: 'https://www.xiaohongshu.com/explore/abc',
  highlight: {
    before: '先说背景：',
    quote: '每天手工对账三小时',
    after: '，旺季更久。',
  },
};

const E19: ReportEvidenceItem = {
  id: 19,
  quote: '399 一个月太贵',
  platform: 'Reddit',
  publishedAt: new Date(2026, 0, 7),
  signal: 'paying',
  firstHand: true,
  supports: '已经在为替代方案付费',
  doesNotProve: '不能证明愿意换到更便宜的产品',
  rejectedReason: null,
  sourceUrl: 'https://www.reddit.com/r/ecommerce/xyz',
  highlight: null,
};

const REPORT: ReportRecord = {
  id: 1,
  sections: sections({
    summary: {
      claims: [
        { text: '最值得做的方向是库存同步', evidenceIds: [12] },
        { text: '竞品集中在 99 元区间', evidenceIds: [19] },
      ],
      unknowns: ['未收集竞品差评', '缺少长期留存数据'],
    },
    evidence: {
      claims: [{ text: '卖家每天手工对账三小时', evidenceIds: [12] }],
      unknowns: [],
    },
  }),
  rubricTotal: 78,
  grade: 'B',
  decision: '建议先验证，再开发',
  createdAt: new Date(2026, 9, 29),
};

describe('ReportView', () => {
  it('renders the decision, rubric total and credibility from the stored report', () => {
    render(
      <ReportView
        runId={7}
        ideaTitle="跨境卖家库存同步"
        report={REPORT}
        scores={[]}
        evidenceMap={{ 12: E12, 19: E19 }}
      />,
    );

    expect(screen.getByRole('heading', { level: 1, name: '跨境卖家库存同步' })).toBeVisible();
    expect(screen.getByText('建议先验证，再开发')).toBeVisible();
    expect(screen.getByText('78 / 100')).toBeVisible();
    expect(screen.getByLabelText('可信度 B')).toHaveTextContent('B');
    expect(screen.getByRole('heading', { level: 2, name: '一、执行摘要' })).toBeVisible();
  });

  it('collapses a section’s unknowns and expands them on demand', async () => {
    const user = userEvent.setup();
    render(
      <ReportView
        runId={7}
        ideaTitle="跨境卖家库存同步"
        report={REPORT}
        scores={[]}
        evidenceMap={{ 12: E12, 19: E19 }}
      />,
    );

    const toggle = screen.getByRole('button', { name: '本节未知项 2' });
    const list = screen.getByText('未收集竞品差评').closest('ul');

    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(list).toHaveClass('hidden');

    await user.click(toggle);

    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(list).not.toHaveClass('hidden');
    expect(within(list as HTMLElement).getByText('缺少长期留存数据')).toBeInTheDocument();
  });

  it('switches the citation panel and opens the drawer when a chip is clicked', async () => {
    const user = userEvent.setup();
    render(
      <ReportView
        runId={7}
        ideaTitle="跨境卖家库存同步"
        report={REPORT}
        scores={[]}
        evidenceMap={{ 12: E12, 19: E19 }}
      />,
    );

    expect(screen.getByRole('heading', { name: '引用 e12' })).toBeVisible();

    await user.click(screen.getByRole('button', { name: '证据 e19' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: '引用 e19' })).toBeVisible();
    expect(within(dialog).getByText('399 一个月太贵')).toBeVisible();
    expect(within(dialog).getByText('不能证明愿意换到更便宜的产品')).toBeVisible();
    expect(within(dialog).getByRole('link', { name: '打开原文链接' })).toHaveAttribute(
      'href',
      E19.sourceUrl,
    );
  });

  it('marks an uncited claim as such and warns the console', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const report: ReportRecord = {
      ...REPORT,
      sections: sections({
        finance: { claims: [{ text: '没有引用的财务预测', evidenceIds: [] }], unknowns: [] },
      }),
    };

    render(
      <ReportView
        runId={7}
        ideaTitle="跨境卖家库存同步"
        report={report}
        scores={[]}
        evidenceMap={{ 12: E12, 19: E19 }}
      />,
    );

    expect(screen.getByText('无引用')).toBeVisible();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('1 条论断没有引用'),
      expect.arrayContaining([expect.stringContaining('没有引用的财务预测')]),
    );
  });

  it('downloads the Markdown returned by the export action', async () => {
    const user = userEvent.setup();
    vi.mocked(exportReportAction).mockResolvedValue({
      ok: true,
      value: { filename: '跨境卖家库存同步-2026-10-29.md', content: '# 报告' },
    });

    const createObjectURL = vi.fn(() => 'blob:report');
    Object.defineProperty(URL, 'createObjectURL', { writable: true, value: createObjectURL });
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, 'revokeObjectURL', { writable: true, value: revokeObjectURL });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    render(
      <ReportView
        runId={7}
        ideaTitle="跨境卖家库存同步"
        report={REPORT}
        scores={[]}
        evidenceMap={{ 12: E12, 19: E19 }}
      />,
    );

    await user.click(screen.getByRole('button', { name: '导出 Markdown' }));

    await waitFor(() => expect(exportReportAction).toHaveBeenCalledWith(7));
    expect(createObjectURL).toHaveBeenCalled();
    expect(click).toHaveBeenCalled();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:report');
  });

  it('renders analyst inferences apart from cited claims', () => {
    render(
      <ReportView
        runId={7}
        ideaTitle="跨境卖家库存同步"
        report={{
          ...REPORT,
          sections: sections({
            summary: {
              claims: [{ text: '手工对账每天三小时', evidenceIds: [12] }],
              unknowns: [],
              inferences: ['推断：竞品按席位收费，说明按人头定价是主流，但样本只有 3 家'],
            },
          }),
        }}
        scores={[]}
        evidenceMap={{ 12: E12, 19: E19 }}
      />,
    );

    expect(screen.getByText('分析判断（推断，非事实）')).toBeVisible();
    expect(screen.getByText(/竞品按席位收费/)).toBeVisible();
    expect(screen.getByText('手工对账每天三小时')).toBeInTheDocument();
  });
});

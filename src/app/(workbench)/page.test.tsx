import { render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { listRuns, type RunSummaryRecord } from '@/lib/runs/repository';

import WorkbenchPage from './page';

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

vi.mock('@/lib/runs/repository', () => ({ listRuns: vi.fn() }));

const mockListRuns = vi.mocked(listRuns);

const RUNS: RunSummaryRecord[] = [
  {
    id: 11,
    ideaTitle: '跨境卖家多平台库存同步',
    status: 'running',
    stage: 'S2',
    hasReport: false,
    rubricTotal: null,
    credibilityGrade: null,
    decision: null,
    updatedAt: new Date('2026-10-30T08:00:00Z'),
  },
  {
    id: 10,
    ideaTitle: '独立开发者发票与报销',
    status: 'finished',
    stage: 'S6',
    hasReport: true,
    rubricTotal: 71,
    credibilityGrade: 'B',
    decision: '建议先验证，再开发',
    updatedAt: new Date('2026-10-29T08:00:00Z'),
  },
  {
    id: 9,
    ideaTitle: '宠物健康订阅盒',
    status: 'finished',
    stage: 'S6',
    hasReport: true,
    rubricTotal: 34,
    credibilityGrade: 'D',
    decision: '建议放弃',
    updatedAt: new Date('2026-10-28T08:00:00Z'),
  },
  {
    id: 8,
    ideaTitle: '小红书选题与竞品监控',
    status: 'failed',
    stage: 'S1',
    hasReport: false,
    rubricTotal: null,
    credibilityGrade: null,
    decision: null,
    updatedAt: new Date('2026-10-27T08:00:00Z'),
  },
];

function resolveWith(runs: RunSummaryRecord[]): void {
  mockListRuns.mockResolvedValue({ ok: true, value: runs });
}

beforeEach(() => {
  resolveWith(RUNS);
});

describe('WorkbenchPage', () => {
  it('renders a semantic table with a caption and the four newest runs', async () => {
    render(await WorkbenchPage());

    const table = screen.getByRole('table');
    const rows = within(table).getAllByRole('row');
    const columnHeaders = within(table).getAllByRole('columnheader');

    expect(mockListRuns).toHaveBeenCalledWith(4);
    // Header row + four runs.
    expect(rows).toHaveLength(5);
    expect(table.querySelector('caption')).toHaveTextContent('最近的研究方向');
    expect(columnHeaders).toHaveLength(5);
    for (const header of columnHeaders) {
      expect(header).toHaveAttribute('scope', 'col');
    }
  });

  it('shows the abandoned run with its D grade, score and decision', async () => {
    render(await WorkbenchPage());

    const row = screen.getByRole('link', { name: '宠物健康订阅盒' }).closest('tr');

    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).getByLabelText('可信度 D')).toHaveTextContent('D');
    expect(within(row as HTMLElement).getByText('建议放弃')).toBeInTheDocument();
    expect(within(row as HTMLElement).getByText('34')).toBeInTheDocument();
  });

  it('renders a running run without a score or grade', async () => {
    render(await WorkbenchPage());

    const row = screen.getByRole('link', { name: '跨境卖家多平台库存同步' }).closest('tr');

    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).getByText('进行中')).toBeInTheDocument();
    expect(within(row as HTMLElement).getByText('— / —')).toBeInTheDocument();
    expect(within(row as HTMLElement).queryByRole('img')).not.toBeInTheDocument();
  });

  it('links a run with a report to the report page and one without to the monitor', async () => {
    render(await WorkbenchPage());

    expect(screen.getByRole('link', { name: '独立开发者发票与报销' })).toHaveAttribute(
      'href',
      '/runs/10/report',
    );
    expect(screen.getByRole('link', { name: '跨境卖家多平台库存同步' })).toHaveAttribute(
      'href',
      '/runs/11',
    );
  });

  it('offers a first-run action when the database has no runs', async () => {
    resolveWith([]);
    render(await WorkbenchPage());

    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.getByText('还没有研究记录')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '发起第一次研究' })).toHaveAttribute(
      'href',
      '/threads/new',
    );
  });
});

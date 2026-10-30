import { render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { listRuns, type RunSummaryRecord } from '@/lib/runs/repository';

import RunsPage from './page';

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

vi.mock('@/lib/runs/repository', () => ({ listRuns: vi.fn() }));

const mockListRuns = vi.mocked(listRuns);

const RUNS: RunSummaryRecord[] = [
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
    ideaTitle: '小红书选题与竞品监控',
    status: 'failed',
    stage: 'S1',
    hasReport: false,
    rubricTotal: null,
    credibilityGrade: null,
    decision: null,
    updatedAt: new Date('2026-10-28T08:00:00Z'),
  },
];

beforeEach(() => {
  mockListRuns.mockResolvedValue({ ok: true, value: RUNS });
});

describe('RunsPage', () => {
  it('lists the newest runs with monitor, report, evidence and plan entry points', async () => {
    render(await RunsPage());

    expect(mockListRuns).toHaveBeenCalledWith(50);
    const table = screen.getByRole('table');
    expect(within(table).getAllByRole('row')).toHaveLength(3);
    expect(table.querySelector('caption')).toHaveTextContent('最近 50 次研究');

    expect(screen.getByRole('link', { name: '独立开发者发票与报销' })).toHaveAttribute(
      'href',
      '/runs/10',
    );
    const firstRow = screen.getAllByRole('row')[1] as HTMLElement;
    expect(within(firstRow).getByRole('link', { name: '监控' })).toHaveAttribute(
      'href',
      '/runs/10',
    );
  });

  it('links to the report when it exists and disables the link when it does not', async () => {
    render(await RunsPage());

    const [withReport, withoutReport] = screen.getAllByRole('row').slice(1);

    expect(within(withReport as HTMLElement).getByRole('link', { name: '报告' })).toHaveAttribute(
      'href',
      '/runs/10/report',
    );
    expect(within(withReport as HTMLElement).getByText('已生成')).toBeInTheDocument();

    const disabled = within(withoutReport as HTMLElement).getByLabelText('报告尚未生成');
    expect(disabled).toHaveAttribute('aria-disabled', 'true');
    expect(disabled).not.toHaveAttribute('href');
    expect(within(withoutReport as HTMLElement).getByText('未生成')).toBeInTheDocument();
  });

  it('never emits the retired /runs/latest links', async () => {
    render(await RunsPage());

    for (const link of screen.getAllByRole('link')) {
      expect(link.getAttribute('href') ?? '').not.toContain('/runs/latest');
    }
  });

  it('offers a first-run action when there are no runs', async () => {
    mockListRuns.mockResolvedValue({ ok: true, value: [] });
    render(await RunsPage());

    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: '发起第一次研究' })).toHaveAttribute(
      'href',
      '/threads/new',
    );
  });
});

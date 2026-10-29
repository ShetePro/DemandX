import { render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import WorkbenchPage from './page';

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

describe('WorkbenchPage', () => {
  it('renders a semantic table with a caption and four data rows', () => {
    render(<WorkbenchPage />);

    const table = screen.getByRole('table');
    const rows = within(table).getAllByRole('row');
    const columnHeaders = within(table).getAllByRole('columnheader');

    // Header row + four runs.
    expect(rows).toHaveLength(5);
    expect(table.querySelector('caption')).toHaveTextContent('研究方向列表');
    expect(columnHeaders).toHaveLength(5);
    for (const header of columnHeaders) {
      expect(header).toHaveAttribute('scope', 'col');
    }
  });

  it('marks the abandoned run with the D grade and its decision', () => {
    render(<WorkbenchPage />);

    const row = screen.getByRole('link', { name: '宠物健康订阅盒' }).closest('tr');

    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).getByLabelText('可信度 D')).toHaveTextContent('D');
    expect(within(row as HTMLElement).getByText('建议放弃')).toBeInTheDocument();
    expect(within(row as HTMLElement).getByText('34')).toBeInTheDocument();
  });

  it('renders the running run without a score or grade', () => {
    render(<WorkbenchPage />);

    const row = screen.getByRole('link', { name: '跨境卖家多平台库存同步' }).closest('tr');

    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).getByText('进行中')).toBeInTheDocument();
    expect(within(row as HTMLElement).getByText('— / —')).toBeInTheDocument();
    expect(within(row as HTMLElement).queryByRole('img')).not.toBeInTheDocument();
  });

  it('links every run title to the report route', () => {
    render(<WorkbenchPage />);

    for (const link of screen.getAllByRole('link')) {
      expect(link).toHaveAttribute('href', '/runs/latest/report');
    }
  });
});

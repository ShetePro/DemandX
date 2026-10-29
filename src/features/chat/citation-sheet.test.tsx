import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { CitationSheet } from './citation-sheet';

describe('CitationSheet', () => {
  it('keeps the evidence link disabled until the route exists', () => {
    render(<CitationSheet citationId="e12" evidenceHref="/runs/7/evidence" onClose={vi.fn()} />);

    expect(screen.getByRole('heading', { name: '证据 e12' })).toBeVisible();
    expect(screen.getByText('证据 e12 尚未入库（P4 接入）')).toBeVisible();
    expect(screen.getByRole('button', { name: '打开证据库' })).toBeDisabled();
    expect(screen.getByText('证据库将在 P4 接入，路由暂未上线。')).toBeVisible();
  });

  it('disables the link and says why before a run exists', () => {
    render(<CitationSheet citationId="e3" evidenceHref={null} onClose={vi.fn()} />);

    expect(screen.getByRole('button', { name: '打开证据库' })).toBeDisabled();
    expect(screen.getByText('研究尚未开始，证据库链接不可用。')).toBeVisible();
  });
});

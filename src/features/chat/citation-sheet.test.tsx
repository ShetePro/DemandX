import { render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { CitationSheet } from './citation-sheet';

vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: ComponentProps<'a'> & { href: string }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

describe('CitationSheet', () => {
  it('links to the evidence page once the run exists', () => {
    render(<CitationSheet citationId="e12" evidenceHref="/runs/7/evidence" onClose={vi.fn()} />);

    expect(screen.getByRole('heading', { name: '证据 e12' })).toBeVisible();
    expect(screen.getByText('证据 e12 的原文、快照高亮与状态在证据库中查看')).toBeVisible();
    expect(screen.getByRole('link', { name: '打开证据库' })).toHaveAttribute(
      'href',
      '/runs/7/evidence',
    );
    expect(screen.queryByRole('button', { name: '打开证据库' })).not.toBeInTheDocument();
  });

  it('disables the link and says why before a run exists', () => {
    render(<CitationSheet citationId="e3" evidenceHref={null} onClose={vi.fn()} />);

    expect(screen.getByRole('button', { name: '打开证据库' })).toBeDisabled();
    expect(screen.getByText('研究尚未开始，证据库链接不可用。')).toBeVisible();
  });
});

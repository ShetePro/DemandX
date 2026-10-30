import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { SourceEventSummary } from '@/lib/runs/sources-repository';

import { DegradationBanner } from './degradation-banner';

const CLEAN: Pick<SourceEventSummary, 'skipped' | 'capped' | 'cappedMaxPages' | 'reasons'> = {
  skipped: 0,
  capped: false,
  cappedMaxPages: null,
  reasons: [],
};

describe('DegradationBanner', () => {
  it('lists skip reasons with their counts', () => {
    render(
      <DegradationBanner
        status="finished"
        summary={{
          ...CLEAN,
          skipped: 3,
          reasons: [
            { reason: 'robots', count: 2 },
            { reason: 'near_duplicate', count: 1 },
          ],
        }}
        error={null}
      />,
    );

    expect(screen.getByText('部分采集未完成')).toBeVisible();
    expect(screen.getByText('robots 限制 · 2')).toBeVisible();
    expect(screen.getByText('近似重复 · 1')).toBeVisible();
  });

  it('shows the page cap even when nothing was skipped for a reason', () => {
    render(
      <DegradationBanner
        status="finished"
        summary={{ ...CLEAN, capped: true, cappedMaxPages: 120 }}
        error={null}
      />,
    );

    expect(screen.getByText('部分采集未完成')).toBeVisible();
    expect(screen.getByText('达到采集上限（最多 120 页）')).toBeVisible();
  });

  it('explains a failed run with its error code', () => {
    render(<DegradationBanner status="failed" summary={CLEAN} error="DEADLINE_EXCEEDED" />);

    expect(screen.getByText('部分采集未完成')).toBeVisible();
    expect(screen.getByText('错误代码：DEADLINE_EXCEEDED')).toBeVisible();
  });

  it('renders nothing when the collection was complete', () => {
    const { container } = render(
      <DegradationBanner status="running" summary={CLEAN} error={null} />,
    );

    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText('部分采集未完成')).not.toBeInTheDocument();
  });
});

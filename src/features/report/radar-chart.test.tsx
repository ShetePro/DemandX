import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { DimensionScore } from '@/lib/scoring/types';

import { RadarChart } from './radar-chart';

const SCORES: DimensionScore[] = [
  { dimension: 'needs', points: 16, rationale: '', evidenceIds: [] },
  { dimension: 'payment', points: 8, rationale: '', evidenceIds: [] },
  { dimension: 'gap', points: 10, rationale: '', evidenceIds: [] },
  { dimension: 'acquisition', points: 10, rationale: '', evidenceIds: [] },
  { dimension: 'profit', points: 5, rationale: '', evidenceIds: [] },
  { dimension: 'feasibility', points: 10, rationale: '', evidenceIds: [] },
  { dimension: 'longevity', points: 3, rationale: '', evidenceIds: [] },
];

describe('RadarChart', () => {
  it('renders an svg only after mount, with the seven axis labels', async () => {
    const { container } = render(<RadarChart scores={SCORES} />);

    await waitFor(() => expect(container.querySelector('svg')).not.toBeNull());

    expect(screen.getByRole('img', { name: '七维评分雷达图' })).toBeInTheDocument();
    expect(container.querySelectorAll('.recharts-polygon').length).toBeGreaterThan(0);
    expect(await screen.findByText('真实需求 16')).toBeInTheDocument();
    expect(await screen.findByText('付费意愿 8')).toBeInTheDocument();
  });

  it('plots a missing dimension as zero instead of dropping the axis', async () => {
    const { container } = render(<RadarChart scores={[SCORES[0] as DimensionScore]} />);

    await waitFor(() => expect(container.querySelector('svg')).not.toBeNull());

    expect(await screen.findByText('长期潜力 0')).toBeInTheDocument();
  });
});

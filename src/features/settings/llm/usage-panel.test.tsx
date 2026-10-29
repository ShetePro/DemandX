import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { ProviderRow, ProviderUsageSummary } from '@/lib/llm/types';

import { UsagePanel } from './usage-panel';

const USAGE: ProviderUsageSummary = {
  providerId: 1,
  fiveHourRequests: 12,
  weeklyRequests: 31,
  monthlyRequests: 40,
  monthlySpendUsd: 9.6,
};

function provider(overrides: Partial<ProviderRow> = {}): ProviderRow {
  return {
    id: 1,
    name: '本地 Ollama',
    kind: 'ollama',
    baseUrl: 'http://127.0.0.1:11434',
    keyMask: null,
    headers: {},
    enabled: true,
    monthlyAllowanceUsd: null,
    ...overrides,
  };
}

describe('UsagePanel', () => {
  it('renders counts only when the provider has no declared allowance', () => {
    render(<UsagePanel provider={provider()} usage={USAGE} />);

    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    expect(screen.getByText('12 次')).toBeInTheDocument();
    expect(screen.getByText('31 次')).toBeInTheDocument();
    expect(screen.getByText('40 次')).toBeInTheDocument();
  });

  it('draws only the monthly bar against the declared allowance', () => {
    render(<UsagePanel provider={provider({ monthlyAllowanceUsd: 80 })} usage={USAGE} />);

    const bars = screen.getAllByRole('progressbar');
    expect(bars).toHaveLength(1);
    expect(bars[0]).toHaveAttribute('aria-valuenow', '12');
    expect(screen.getByText('$9.60 / $80.00')).toBeInTheDocument();
    expect(screen.getByText('5 小时 / 本周为计数，相对最忙窗口，非配额')).toBeInTheDocument();
  });
});

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { SignalBadge, type Signal } from './signal-badge';

const SIGNALS: readonly { signal: Signal; label: string; ariaLabel: string }[] = [
  { signal: 'problem', label: '问题', ariaLabel: '信号：问题存在' },
  { signal: 'seeking', label: '寻找', ariaLabel: '信号：主动寻找' },
  { signal: 'paying', label: '付费', ariaLabel: '信号：已付费' },
  { signal: 'switching', label: '切换', ariaLabel: '信号：愿意切换' },
  { signal: 'recurring', label: '持续', ariaLabel: '信号：持续付费' },
];

describe('SignalBadge', () => {
  it.each(SIGNALS)(
    'renders $signal as $label with a full aria-label',
    ({ signal, label, ariaLabel }) => {
      render(<SignalBadge signal={signal} />);

      const badge = screen.getByRole('img', { name: ariaLabel });

      expect(badge).toHaveTextContent(label);
    },
  );

  it('uses the semantic signal palette without hard-coded colors', () => {
    render(<SignalBadge signal="paying" />);

    const badge = screen.getByLabelText('信号：已付费');

    expect(badge.className).toContain('text-success');
    expect(badge.className).not.toMatch(/#[0-9a-f]{3,8}/i);
  });
});

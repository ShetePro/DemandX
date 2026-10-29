import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Progress } from './progress';

describe('Progress', () => {
  it('exposes the current value to assistive technology', () => {
    render(<Progress value={42} />);

    const progressbar = screen.getByRole('progressbar');

    expect(progressbar).toHaveAttribute('aria-valuenow', '42');
    expect(progressbar).toHaveAttribute('aria-valuemin', '0');
    expect(progressbar).toHaveAttribute('aria-valuemax', '100');
  });

  it('clamps out-of-range values to 0–100', () => {
    const { rerender } = render(<Progress value={130} />);
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100');

    rerender(<Progress value={-20} />);
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0');
  });
});

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { GradeBadge, type Grade } from './grade-badge';

const GRADES: readonly Grade[] = ['A', 'B', 'C', 'D'];

describe('GradeBadge', () => {
  it.each(GRADES)('labels grade %s for screen readers', (grade) => {
    render(<GradeBadge grade={grade} />);

    const badge = screen.getByRole('img', { name: `可信度 ${grade}` });

    expect(badge).toHaveTextContent(grade);
  });

  it('uses the semantic grade palette without hard-coded colors', () => {
    render(<GradeBadge grade="D" />);

    const badge = screen.getByLabelText('可信度 D');

    expect(badge.className).toContain('text-danger');
    expect(badge.className).not.toMatch(/#[0-9a-f]{3,8}/i);
  });
});

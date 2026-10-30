import { describe, expect, it } from 'vitest';

import { DEFAULT_PLAN, VALIDATION_PLAN_DAYS } from './template';

describe('DEFAULT_PLAN', () => {
  it('covers exactly 14 days, one task each', () => {
    expect(DEFAULT_PLAN).toHaveLength(VALIDATION_PLAN_DAYS);
    expect(DEFAULT_PLAN.map((item) => item.day)).toEqual(
      Array.from({ length: 14 }, (_, index) => index + 1),
    );
  });

  it('gives every day a non-empty title', () => {
    for (const item of DEFAULT_PLAN) {
      expect(item.title.trim()).not.toBe('');
    }
    expect(new Set(DEFAULT_PLAN.map((item) => item.title)).size).toBe(DEFAULT_PLAN.length);
  });
});

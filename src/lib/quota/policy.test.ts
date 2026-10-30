import { describe, expect, it } from 'vitest';

import { DEFAULT_QUOTA, QUOTA_WINDOWS, windowStart } from './policy';

describe('windowStart', () => {
  it('floors a minute to its first instant, dropping seconds and milliseconds', () => {
    expect(windowStart('minute', new Date('2026-10-30T12:34:56.789Z'))).toEqual(
      new Date('2026-10-30T12:34:00.000Z'),
    );
  });

  it('floors a day to UTC midnight', () => {
    expect(windowStart('day', new Date('2026-10-30T23:59:59.999Z'))).toEqual(
      new Date('2026-10-30T00:00:00.000Z'),
    );
  });

  it('starts weeks on Monday, so Sunday belongs to the previous week', () => {
    // Friday 2026-10-30 and Sunday 2026-11-01 share the Monday 2026-10-26 window.
    expect(windowStart('week', new Date('2026-10-30T12:00:00Z'))).toEqual(
      new Date('2026-10-26T00:00:00.000Z'),
    );
    expect(windowStart('week', new Date('2026-11-01T23:59:59Z'))).toEqual(
      new Date('2026-10-26T00:00:00.000Z'),
    );
    // Monday at 00:00 is already the next window.
    expect(windowStart('week', new Date('2026-11-02T00:00:00Z'))).toEqual(
      new Date('2026-11-02T00:00:00.000Z'),
    );
  });

  it('starts a week across a year boundary on the previous December Monday', () => {
    // Thursday 2026-01-01 belongs to the week starting Monday 2025-12-29.
    expect(windowStart('week', new Date('2026-01-01T12:00:00Z'))).toEqual(
      new Date('2025-12-29T00:00:00.000Z'),
    );
  });

  it('floors a month to its first day, across year boundaries', () => {
    expect(windowStart('month', new Date('2026-01-15T12:00:00Z'))).toEqual(
      new Date('2026-01-01T00:00:00.000Z'),
    );
    expect(windowStart('month', new Date('2026-12-31T23:59:59.999Z'))).toEqual(
      new Date('2026-12-01T00:00:00.000Z'),
    );
  });

  it('rejects an invalid clock', () => {
    expect(() => windowStart('day', new Date(Number.NaN))).toThrow(RangeError);
  });
});

describe('DEFAULT_QUOTA', () => {
  it('meters every built-in source with a supported window and a positive limit', () => {
    expect(Object.keys(DEFAULT_QUOTA).sort()).toEqual([
      'appstore',
      'bing',
      'ddg',
      'github',
      'hn',
      'llm',
    ]);
    for (const rule of Object.values(DEFAULT_QUOTA)) {
      expect(QUOTA_WINDOWS).toContain(rule.window);
      expect(rule.limit).toBeGreaterThan(0);
    }
  });
});

import { describe, expect, it } from 'vitest';

import { formatCurrency, formatDuration, formatRelativeTime, formatScore } from './format';

describe('formatRelativeTime', () => {
  const now = new Date(2026, 9, 30, 12, 0, 0);

  it('renders 刚刚 under one minute', () => {
    expect(formatRelativeTime(new Date(now.getTime() - 59_000), now)).toBe('刚刚');
    expect(formatRelativeTime(now, now)).toBe('刚刚');
  });

  it('renders 分钟前 under one hour', () => {
    expect(formatRelativeTime(new Date(now.getTime() - 60_000), now)).toBe('1 分钟前');
    expect(formatRelativeTime(new Date(now.getTime() - 2 * 60_000), now)).toBe('2 分钟前');
    expect(formatRelativeTime(new Date(now.getTime() - 59 * 60_000), now)).toBe('59 分钟前');
  });

  it('renders 小时前 under one day', () => {
    expect(formatRelativeTime(new Date(now.getTime() - 60 * 60_000), now)).toBe('1 小时前');
    expect(formatRelativeTime(new Date(now.getTime() - 23 * 60 * 60_000), now)).toBe('23 小时前');
  });

  it('renders 天前 under one week', () => {
    expect(formatRelativeTime(new Date(now.getTime() - 24 * 60 * 60_000), now)).toBe('1 天前');
    expect(formatRelativeTime(new Date(now.getTime() - 6 * 24 * 60 * 60_000), now)).toBe('6 天前');
  });

  it('falls back to an absolute date from one week on', () => {
    expect(formatRelativeTime(new Date(2026, 9, 23, 12, 0, 0), now)).toBe('2026-10-23');
    expect(formatRelativeTime(new Date(2025, 0, 5, 0, 0, 0), now)).toBe('2025-01-05');
  });

  it('treats a future timestamp as just now', () => {
    const now = new Date(2026, 9, 30, 12, 0, 0);
    expect(formatRelativeTime(new Date(now.getTime() + 60_000), now)).toBe('刚刚');
  });

  it('measures elapsed time, not calendar days, across midnight', () => {
    const lateNight = new Date(2026, 9, 29, 23, 59, 0);
    const afterMidnight = new Date(2026, 9, 30, 0, 1, 0);

    expect(formatRelativeTime(lateNight, afterMidnight)).toBe('2 分钟前');
  });
});

describe('formatDuration', () => {
  it('renders seconds, minutes and hours', () => {
    expect(formatDuration(0)).toBe('0 秒');
    expect(formatDuration(45_000)).toBe('45 秒');
    expect(formatDuration(60_000)).toBe('1 分钟');
    expect(formatDuration(95_000)).toBe('1 分 35 秒');
    expect(formatDuration(90 * 60_000)).toBe('1 小时 30 分钟');
    expect(formatDuration(2 * 60 * 60_000)).toBe('2 小时');
  });

  it('refuses negative or non-finite input', () => {
    expect(formatDuration(-1)).toBe('—');
    expect(formatDuration(Number.NaN)).toBe('—');
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe('—');
  });
});

describe('formatScore', () => {
  it('renders scores as integer strings', () => {
    expect(formatScore(0)).toBe('0');
    expect(formatScore(71)).toBe('71');
    expect(formatScore(100)).toBe('100');
    expect(formatScore(71.6)).toBe('72');
  });

  it('rejects out-of-range scores', () => {
    expect(() => formatScore(-1)).toThrow(RangeError);
    expect(() => formatScore(101)).toThrow(RangeError);
    expect(() => formatScore(Number.NaN)).toThrow(RangeError);
  });
});

describe('formatCurrency', () => {
  it('formats known currencies with the zh-CN locale', () => {
    expect(formatCurrency(1234.5, 'CNY')).toBe('¥1,234.50');
    expect(formatCurrency(0, 'CNY')).toBe('¥0.00');
  });

  it('falls back to plain text for unknown currency codes', () => {
    expect(formatCurrency(1234.5, 'NOTACURRENCY')).toBe('NOTACURRENCY 1234.5');
  });
});

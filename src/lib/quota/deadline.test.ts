import { describe, expect, it } from 'vitest';

import { assertAlive } from './deadline';

const NOW = new Date('2026-10-30T12:00:00Z');

describe('assertAlive', () => {
  it('treats a null deadline as unlimited', () => {
    expect(assertAlive(null, NOW)).toEqual({ ok: true, value: undefined });
  });

  it('allows a run whose deadline is still in the future', () => {
    expect(assertAlive(new Date('2026-10-30T12:00:00.001Z'), NOW)).toEqual({
      ok: true,
      value: undefined,
    });
    expect(assertAlive(new Date('2026-10-30T13:00:00Z'), NOW)).toEqual({
      ok: true,
      value: undefined,
    });
  });

  it('rejects at the exact deadline instant', () => {
    const result = assertAlive(new Date('2026-10-30T12:00:00Z'), NOW);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a failure result, got ok');
    expect(result.code).toBe('DEADLINE_EXCEEDED');
    expect(result.message).toContain('2026-10-30T12:00:00.000Z');
  });

  it('rejects an already expired deadline', () => {
    const result = assertAlive(new Date('2026-10-30T11:59:59Z'), NOW);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a failure result, got ok');
    expect(result.code).toBe('DEADLINE_EXCEEDED');
  });
});

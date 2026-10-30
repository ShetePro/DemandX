import { describe, expect, it } from 'vitest';

import type { Signal } from '@/lib/evidence/schema';

import {
  aggregateEvidence,
  loadAggregate,
  type AggregateEvidenceRow,
  type PriceMention,
} from './aggregate';

const PRICE: PriceMention = { amount: 99, currency: 'USD' };

/** An accepted row by default; the flags are the only thing tests vary. */
function row(
  sourceId: number,
  signal: Signal,
  patch: { priceMentioned?: PriceMention | null; rejectedReason?: string | null } = {},
): AggregateEvidenceRow {
  return {
    sourceId,
    signal,
    priceMentioned: patch.priceMentioned ?? null,
    rejectedReason: patch.rejectedReason ?? null,
  };
}

describe('aggregateEvidence', () => {
  it('returns all zeros with both counts unknown for an empty run', () => {
    expect(aggregateEvidence([])).toEqual({
      n: 0,
      p: 0,
      c: 0,
      comp: 0,
      r: 0,
      hasVerifiablePrice: false,
      known: { competitors: false, complaints: false },
    });
  });

  it('counts one source once however many quotes it contributed', () => {
    const aggregate = aggregateEvidence([
      row(7, 'problem'),
      row(7, 'seeking'),
      row(7, 'paying'),
      row(9, 'problem'),
    ]);

    expect(aggregate.n).toBe(2);
  });

  it('does not count the same source twice across different signals', () => {
    const aggregate = aggregateEvidence([row(1, 'problem'), row(2, 'paying'), row(2, 'recurring')]);

    expect(aggregate.n).toBe(2);
    expect(aggregate.p).toBe(1);
    expect(aggregate.r).toBe(1);
  });

  it('counts every accepted paying row, not just one per source', () => {
    const aggregate = aggregateEvidence([
      row(1, 'paying'),
      row(1, 'paying', { priceMentioned: PRICE }),
      row(2, 'paying'),
    ]);

    expect(aggregate.p).toBe(3);
    expect(aggregate.n).toBe(2);
  });

  it('counts recurring evidence separately from paying evidence', () => {
    const aggregate = aggregateEvidence([
      row(1, 'recurring'),
      row(2, 'recurring'),
      row(3, 'paying'),
    ]);

    expect(aggregate.r).toBe(2);
    expect(aggregate.p).toBe(1);
  });

  it('keeps rejected rows out of every count', () => {
    const aggregate = aggregateEvidence([
      row(1, 'paying', { priceMentioned: PRICE }),
      row(2, 'recurring'),
      row(3, 'problem'),
      row(4, 'paying', { rejectedReason: 'quote_not_in_snapshot' }),
      row(5, 'recurring', { rejectedReason: 'quote_not_in_snapshot' }),
      row(6, 'problem', { rejectedReason: 'empty_quote' }),
    ]);

    expect(aggregate).toMatchObject({ n: 3, p: 1, r: 1, hasVerifiablePrice: true });
  });

  it('treats a run of only rejected rows as no evidence at all', () => {
    const aggregate = aggregateEvidence([
      row(1, 'paying', { priceMentioned: PRICE, rejectedReason: 'quote_too_short' }),
      row(2, 'recurring', { rejectedReason: 'quote_too_short' }),
    ]);

    expect(aggregate.n).toBe(0);
    expect(aggregate.p).toBe(0);
    expect(aggregate.r).toBe(0);
    expect(aggregate.hasVerifiablePrice).toBe(false);
  });

  it('marks a verifiable price when an accepted paying row names one', () => {
    expect(
      aggregateEvidence([row(1, 'paying', { priceMentioned: PRICE })]).hasVerifiablePrice,
    ).toBe(true);
  });

  it('does not mark a verifiable price when only non-paying rows name one', () => {
    const aggregate = aggregateEvidence([
      row(1, 'problem', { priceMentioned: PRICE }),
      row(2, 'paying'),
    ]);

    expect(aggregate.p).toBe(1);
    expect(aggregate.hasVerifiablePrice).toBe(false);
  });

  it('does not mark a verifiable price when the priced paying row was rejected', () => {
    const aggregate = aggregateEvidence([
      row(1, 'paying', { priceMentioned: PRICE, rejectedReason: 'quote_not_in_snapshot' }),
    ]);

    expect(aggregate.hasVerifiablePrice).toBe(false);
  });

  it('reports competitors and complaints as unknown rather than zero-with-confidence', () => {
    const aggregate = aggregateEvidence([row(1, 'paying', { priceMentioned: PRICE })]);

    expect(aggregate.c).toBe(0);
    expect(aggregate.comp).toBe(0);
    expect(aggregate.known).toEqual({ competitors: false, complaints: false });
  });

  it('is deterministic: the same rows in a different order aggregate identically', () => {
    const rows = [
      row(1, 'paying', { priceMentioned: PRICE }),
      row(2, 'recurring'),
      row(1, 'problem'),
    ];

    expect(aggregateEvidence(rows)).toEqual(aggregateEvidence([...rows].reverse()));
  });
});

describe('loadAggregate', () => {
  it('aggregates the rows its reader returned', async () => {
    const result = await loadAggregate(3, {
      read: async (runId) => {
        expect(runId).toBe(3);
        return [row(1, 'paying', { priceMentioned: PRICE }), row(2, 'recurring')];
      },
    });

    expect(result).toEqual({
      ok: true,
      value: {
        n: 2,
        p: 1,
        c: 0,
        comp: 0,
        r: 1,
        hasVerifiablePrice: true,
        known: { competitors: false, complaints: false },
      },
    });
  });

  it('returns STORAGE_FAILED instead of throwing when the read fails', async () => {
    const result = await loadAggregate(3, {
      read: async () => {
        throw Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' });
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a failure');
    expect(result.code).toBe('STORAGE_FAILED');
    expect(result.message).toContain('证据聚合');
    expect(result.message).toContain('ECONNREFUSED');
  });
});

import { describe, expect, it } from 'vitest';

import {
  scoreGap,
  scoreLongevity,
  scoreNeeds,
  scoreOpportunity,
  scoreOrdinal,
  scorePayment,
  type OrdinalDimension,
} from './rubric';
import { DIMENSIONS, LIMITS, type Aggregate } from './types';

const KNOWN_GAP = { competitors: true, complaints: true };
const UNKNOWN_GAP = { competitors: false, complaints: false };

/** An aggregate with no evidence at all; tests override what they care about. */
function aggregate(patch: Partial<Aggregate> = {}): Aggregate {
  return {
    n: patch.n ?? 0,
    p: patch.p ?? 0,
    c: patch.c ?? 0,
    comp: patch.comp ?? 0,
    r: patch.r ?? 0,
    hasVerifiablePrice: patch.hasVerifiablePrice ?? false,
    known: patch.known ?? UNKNOWN_GAP,
  };
}

/** Everything maxed out, including the counts that are not collected yet. */
function maximalAggregate(): Aggregate {
  return aggregate({
    n: 12,
    p: 6,
    c: 3,
    comp: 4,
    r: 3,
    hasVerifiablePrice: true,
    known: KNOWN_GAP,
  });
}

describe('LIMITS', () => {
  it('sums to exactly 100', () => {
    expect(Object.values(LIMITS).reduce((sum, limit) => sum + limit, 0)).toBe(100);
  });

  it('covers all seven dimensions', () => {
    expect(Object.keys(LIMITS).sort()).toEqual([...DIMENSIONS].sort());
  });
});

describe('scoreNeeds', () => {
  it.each([
    [0, 0],
    [1, 6],
    [2, 6],
    [3, 11],
    [4, 11],
    [5, 16],
    [9, 16],
    [10, 20],
    [25, 20],
  ])('needs(%i) = %i', (n, expected) => {
    expect(scoreNeeds(n)).toBe(expected);
  });

  it('treats a negative or non-finite count as zero', () => {
    expect(scoreNeeds(-4)).toBe(0);
    expect(scoreNeeds(Number.NaN)).toBe(0);
  });
});

describe('scorePayment', () => {
  it.each([
    [0, true, 0],
    [1, true, 8],
    [2, true, 13],
    [3, true, 17],
    [4, true, 17],
    [5, true, 20],
    [9, true, 20],
  ])('payment(%i, priced=%s) = %i', (p, priced, expected) => {
    expect(scorePayment(p, priced)).toBe(expected);
  });

  it.each([
    [1, false, 8],
    [2, false, 10],
    [3, false, 10],
    [5, false, 10],
    [50, false, 10],
  ])('payment(%i, priced=%s) caps at 10 → %i', (p, priced, expected) => {
    expect(scorePayment(p, priced)).toBe(expected);
  });

  it('scores zero when nobody paid, whatever the price flags say', () => {
    expect(scorePayment(0, true)).toBe(0);
    expect(scorePayment(0, false)).toBe(0);
  });
});

describe('scoreGap', () => {
  it('scores zero while both counts are uncollected', () => {
    expect(scoreGap(0, 0, UNKNOWN_GAP)).toBe(0);
    // Even a caller claiming competitors must still contribute nothing unasked.
    expect(scoreGap(5, 5, { competitors: false, complaints: true })).toBe(5);
  });

  it.each([
    [0, 0, 0],
    [1, 0, 3],
    [2, 0, 6],
    [3, 0, 10],
    [9, 0, 10],
    [0, 1, 3],
    [0, 2, 3],
    [0, 3, 5],
    [3, 3, 15],
    [1, 2, 6],
    [3, 10, 15],
  ])('gap(c=%i, comp=%i) = %i when both counts are known', (c, comp, expected) => {
    expect(scoreGap(c, comp, KNOWN_GAP)).toBe(expected);
  });

  it('ignores the competitor half when only complaints were collected', () => {
    expect(scoreGap(3, 0, { competitors: false, complaints: true })).toBe(0);
    expect(scoreGap(3, 3, { competitors: false, complaints: true })).toBe(5);
  });

  it('ignores the complaint half when only competitors were collected', () => {
    expect(scoreGap(3, 5, { competitors: true, complaints: false })).toBe(10);
  });
});

describe('scoreOrdinal', () => {
  const ids = [1, 2];

  const tiers: [OrdinalDimension, number, number][] = [
    ['acquisition', 0, 0],
    ['acquisition', 1, 5],
    ['acquisition', 2, 10],
    ['acquisition', 3, 15],
    ['profit', 0, 0],
    ['profit', 1, 5],
    ['profit', 2, 10],
    ['profit', 3, 15],
    ['feasibility', 0, 0],
    ['feasibility', 1, 5],
    ['feasibility', 2, 10],
  ];

  it.each(tiers)('%s ordinal %i = %i', (dimension, ordinal, expected) => {
    expect(scoreOrdinal(dimension, ordinal, ids)).toBe(expected);
  });

  it('truncates feasibility ordinal 3 to the 10-point ceiling', () => {
    // The type allows 0..2; a value from JSON is only guarded at runtime.
    expect(scoreOrdinal('feasibility', 3, ids)).toBe(LIMITS.feasibility);
  });

  it('scores zero when the tier carries no evidence', () => {
    expect(scoreOrdinal('acquisition', 3, [])).toBe(0);
    expect(scoreOrdinal('profit', 3, [])).toBe(0);
    expect(scoreOrdinal('feasibility', 2, [])).toBe(0);
  });

  it('scores zero when the tier is missing', () => {
    expect(scoreOrdinal('acquisition', undefined, ids)).toBe(0);
  });

  it('clamps an out-of-range ordinal instead of exceeding the cap', () => {
    expect(scoreOrdinal('profit', 9, ids)).toBe(LIMITS.profit);
    expect(scoreOrdinal('acquisition', -2, ids)).toBe(0);
  });
});

describe('scoreLongevity', () => {
  it.each([
    [0, 0],
    [1, 2],
    [2, 3],
    [3, 5],
    [12, 5],
  ])('longevity(%i) = %i', (r, expected) => {
    expect(scoreLongevity(r)).toBe(expected);
  });
});

describe('scoreOpportunity', () => {
  it('always returns seven dimensions in report order', () => {
    const { scores } = scoreOpportunity({ aggregate: aggregate(), ordinals: {} });

    expect(scores).toHaveLength(7);
    expect(scores.map((score) => score.dimension)).toEqual([...DIMENSIONS]);
  });

  it('reaches exactly 100 when every input is present and maximal', () => {
    const { total } = scoreOpportunity({
      aggregate: maximalAggregate(),
      ordinals: {
        acquisition: { ordinal: 3, evidenceIds: [1] },
        profit: { ordinal: 3, evidenceIds: [2] },
        feasibility: { ordinal: 2, evidenceIds: [3] },
      },
    });

    expect(total).toBe(100);
  });

  it('never exceeds 100 and never exceeds a dimension ceiling', () => {
    const result = scoreOpportunity({
      aggregate: aggregate({ n: 999, p: 999, c: 999, comp: 999, r: 999, hasVerifiablePrice: true }),
      ordinals: {
        acquisition: { ordinal: 3, evidenceIds: [1] },
        profit: { ordinal: 3, evidenceIds: [1] },
        feasibility: { ordinal: 2, evidenceIds: [1] },
      },
    });

    expect(result.total).toBeLessThanOrEqual(100);
    for (const score of result.scores) {
      expect(score.points).toBeLessThanOrEqual(LIMITS[score.dimension]);
      expect(score.points).toBeGreaterThanOrEqual(0);
    }
  });

  it('reports total as the sum of the dimension points', () => {
    const result = scoreOpportunity({
      aggregate: aggregate({ n: 4, p: 2, r: 1, hasVerifiablePrice: false }),
      ordinals: { acquisition: { ordinal: 2, evidenceIds: [3] } },
    });

    expect(result.total).toBe(result.scores.reduce((sum, score) => sum + score.points, 0));
  });

  it('scores gap 0 with both unknown reasons while no competitor data exists', () => {
    const result = scoreOpportunity({ aggregate: maximalAggregateWith(UNKNOWN_GAP), ordinals: {} });
    const gap = result.scores.find((score) => score.dimension === 'gap');

    expect(gap?.points).toBe(0);
    expect(gap?.unknownReason).toBe('competitors_not_collected');
    expect(result.unknownReasons).toContain('competitors_not_collected');
    expect(result.unknownReasons).toContain('complaints_not_collected');
  });

  it('zeroes the ordinal dimensions and names each missing tier', () => {
    const result = scoreOpportunity({ aggregate: aggregate({ n: 3 }), ordinals: {} });
    const byDimension = new Map(result.scores.map((score) => [score.dimension, score]));

    for (const dimension of ['acquisition', 'profit', 'feasibility'] as const) {
      expect(byDimension.get(dimension)?.points).toBe(0);
      expect(byDimension.get(dimension)?.unknownReason).toBe(`${dimension}_ordinal_missing`);
    }
    expect(result.unknownReasons).toEqual([
      'competitors_not_collected',
      'complaints_not_collected',
      'acquisition_ordinal_missing',
      'profit_ordinal_missing',
      'feasibility_ordinal_missing',
    ]);
  });

  it('zeroes a tier whose evidence list is empty and says why', () => {
    const result = scoreOpportunity({
      aggregate: aggregate(),
      ordinals: { acquisition: { ordinal: 3, evidenceIds: [] } },
    });
    const acquisition = result.scores.find((score) => score.dimension === 'acquisition');

    expect(acquisition?.points).toBe(0);
    expect(acquisition?.unknownReason).toBe('acquisition_evidence_missing');
    expect(result.unknownReasons).toContain('acquisition_evidence_missing');
  });

  it('carries the tier evidence ids into the dimension score', () => {
    const result = scoreOpportunity({
      aggregate: aggregate(),
      ordinals: { profit: { ordinal: 2, evidenceIds: [11, 12] } },
    });
    const profit = result.scores.find((score) => score.dimension === 'profit');

    expect(profit?.points).toBe(10);
    expect(profit?.evidenceIds).toEqual([11, 12]);
    expect(profit?.unknownReason).toBeUndefined();
  });

  it('keeps every rationale non-empty', () => {
    const result = scoreOpportunity({ aggregate: aggregate(), ordinals: {} });

    for (const score of result.scores) {
      expect(score.rationale.length).toBeGreaterThan(0);
    }
  });

  it('scores everything 0 with no evidence and no tiers', () => {
    const result = scoreOpportunity({ aggregate: aggregate(), ordinals: {} });

    expect(result.total).toBe(0);
    expect(result.scores.every((score) => score.points === 0)).toBe(true);
  });
});

/** A maximal aggregate whose gap counts stay unknown. */
function maximalAggregateWith(known: Aggregate['known']): Aggregate {
  return aggregate({ n: 12, p: 6, c: 3, comp: 4, r: 3, hasVerifiablePrice: true, known });
}

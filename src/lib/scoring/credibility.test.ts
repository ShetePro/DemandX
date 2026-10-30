import { describe, expect, it } from 'vitest';

import { credibility, type CredibilityGrade, type CredibilityInput } from './credibility';

/** A report with nothing behind it; each test states only what it cares about. */
function input(patch: Partial<CredibilityInput> = {}): CredibilityInput {
  return {
    needs: patch.needs ?? 0,
    payment: patch.payment ?? 0,
    allClaimsCited: patch.allClaimsCited ?? false,
    independentSources: patch.independentSources ?? 0,
  };
}

function grade(patch: Partial<CredibilityInput>): CredibilityGrade {
  return credibility(input(patch)).grade;
}

describe('credibility — grade A', () => {
  it('tops out when needs and payment are both maximal and every claim is cited', () => {
    expect(grade({ needs: 20, payment: 20, allClaimsCited: true, independentSources: 10 })).toBe(
      'A',
    );
  });

  it('accepts the exact A thresholds (needs 16, payment 13)', () => {
    expect(grade({ needs: 16, payment: 13, allClaimsCited: true, independentSources: 5 })).toBe(
      'A',
    );
  });
});

describe('credibility — grade B', () => {
  it('drops to B when needs stay high but payment is below 13', () => {
    expect(grade({ needs: 20, payment: 12, allClaimsCited: true, independentSources: 5 })).toBe(
      'B',
    );
  });

  it('accepts the exact B thresholds (needs 11, payment 8)', () => {
    expect(grade({ needs: 11, payment: 8, allClaimsCited: true, independentSources: 3 })).toBe('B');
  });
});

describe('credibility — grade C', () => {
  it('caps a thin needs band at C however good the rest looks', () => {
    expect(grade({ needs: 10, payment: 12, allClaimsCited: true, independentSources: 3 })).toBe(
      'C',
    );
  });

  it('caps cross-validation at C when only two sources back a cited score', () => {
    // Citations are complete, but two sources are one thread, not a market.
    const result = credibility(
      input({ needs: 13, payment: 17, allClaimsCited: true, independentSources: 2 }),
    );
    expect(result.grade).toBe('C');
    expect(result.reason).toContain('来源');
  });

  it('reaches C through either row', () => {
    // Weak needs band with plenty of sources.
    expect(grade({ needs: 8, payment: 17, allClaimsCited: true, independentSources: 5 })).toBe('C');
    // Strong needs band with a two-source floor.
    expect(grade({ needs: 13, payment: 17, allClaimsCited: true, independentSources: 2 })).toBe(
      'C',
    );
  });

  it('does not need a citation to cap at C on two sources', () => {
    expect(grade({ needs: 20, payment: 20, allClaimsCited: false, independentSources: 2 })).toBe(
      'C',
    );
  });
});

describe('credibility — grade D', () => {
  it('refuses to trust a score whose needs are below 6', () => {
    expect(grade({ needs: 5, payment: 8, allClaimsCited: true, independentSources: 3 })).toBe('D');
  });

  it('refuses a maximal score with uncited claims', () => {
    expect(grade({ needs: 20, payment: 20, allClaimsCited: false, independentSources: 4 })).toBe(
      'D',
    );
  });
});

describe('credibility — boundaries', () => {
  const cases: [number, number, boolean, number, CredibilityGrade][] = [
    // needs 16 vs 15 with top payment: only 16 reaches A.
    [16, 13, true, 5, 'A'],
    // 15 is B, whatever the payment evidence says — A is a strict subset of B.
    [15, 13, true, 5, 'B'],
    [15, 12, true, 5, 'B'],
    // The 11–15 band with top payment is still B, not D.
    [13, 17, true, 4, 'B'],
    [15, 20, true, 4, 'B'],
    // B needs a third source: two cited sources stay at C.
    [13, 17, true, 3, 'B'],
    [13, 17, true, 2, 'C'],
    [12, 0, true, 2, 'C'],
    // needs 11 vs 10: B needs 11, C owns 6–10.
    [11, 12, true, 3, 'B'],
    [10, 12, true, 3, 'C'],
    // needs 6 vs 5: C's band starts at 6, D owns everything under it.
    [6, 8, true, 3, 'C'],
    [5, 8, true, 3, 'D'],
    // sources 2 vs 3: the C floor is exactly 1–2 once no higher row matched.
    [20, 20, false, 2, 'C'],
    [20, 20, false, 3, 'D'],
    // Uncited claims disqualify A and B alike.
    [20, 20, false, 5, 'D'],
    [20, 12, false, 5, 'D'],
  ];

  it.each(cases)(
    'needs=%i payment=%i cited=%s sources=%i → %s',
    (needs, payment, allClaimsCited, independentSources, expected) => {
      expect(grade({ needs, payment, allClaimsCited, independentSources })).toBe(expected);
    },
  );

  it('grades a sourceless report D even when other inputs would pass', () => {
    // D names "no traceable source at all"; C's floor covers 1–2, not 0–2.
    const result = credibility(input({ needs: 0, payment: 0, independentSources: 0 }));
    expect(result.grade).toBe('D');
    expect(result.reason).toContain('来源');
  });

  it('treats junk numbers as nothing gathered instead of a pass', () => {
    expect(
      grade({
        needs: Number.NaN,
        payment: Number.POSITIVE_INFINITY,
        allClaimsCited: true,
        independentSources: Number.NaN,
      }),
    ).toBe('D');
    expect(grade({ needs: -4, payment: -1, allClaimsCited: true, independentSources: -2 })).toBe(
      'D',
    );
  });

  it('always explains the grade', () => {
    const samples = [
      input({ needs: 20, payment: 20, allClaimsCited: true, independentSources: 9 }),
      input({ needs: 20, payment: 8, allClaimsCited: true, independentSources: 9 }),
      input({ needs: 8, payment: 8, allClaimsCited: true, independentSources: 9 }),
      input({ needs: 2, payment: 8, allClaimsCited: true, independentSources: 9 }),
    ];
    for (const sample of samples) {
      expect(credibility(sample).reason.length).toBeGreaterThan(0);
    }
  });
});

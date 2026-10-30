import { describe, expect, it } from 'vitest';

import { credibility } from './credibility';
import { decide, type Decision, type DecisionInput } from './decision';

/** A mid-scoring report; each test overrides only the numbers its rule reads. */
function input(patch: Partial<DecisionInput> = {}): DecisionInput {
  return {
    total: 0,
    credibility: 'C',
    needs: 11,
    payment: 8,
    feasibility: 10,
    ...patch,
  };
}

function decisionOf(patch: Partial<DecisionInput>): Decision {
  return decide(input(patch)).decision;
}

describe('decide — ① 建议放弃', () => {
  it('abandons a D-grade report however high the total', () => {
    const result = decide(
      input({ total: 90, credibility: 'D', needs: 20, payment: 20, feasibility: 10 }),
    );
    expect(result.decision).toBe('建议放弃');
    expect(result.reason).toContain('可信度 D');
    expect(result.nextStep.length).toBeGreaterThan(0);
  });

  it('abandons a report with at most 6 needs points and no payment evidence', () => {
    expect(decisionOf({ total: 80, needs: 6, payment: 0 })).toBe('建议放弃');
  });

  it('outranks 暂缓: D with a blocked technical feasibility and total ≥50', () => {
    expect(decisionOf({ total: 55, credibility: 'D', needs: 8, payment: 8, feasibility: 2 })).toBe(
      '建议放弃',
    );
  });
});

describe('decide — ② 建议调整定位', () => {
  it('redirects when payment is at most 6 and the total is under 50', () => {
    const result = decide(input({ total: 49, payment: 6 }));
    expect(result.decision).toBe('建议调整定位');
    expect(result.reason).toContain('付费');
    expect(result.nextStep).toContain('定位');
  });

  it('redirects when nobody paid at all but the need is real', () => {
    expect(decisionOf({ total: 30, needs: 11, payment: 0 })).toBe('建议调整定位');
  });

  it('requires total < 50: the same low payment at 50 is not a repositioning call', () => {
    expect(decisionOf({ total: 50, payment: 5 })).toBe('建议先验证，再开发');
  });
});

describe('decide — ③ 建议暂缓', () => {
  it('pauses when feasibility is at most 5 and the total reaches 50', () => {
    const result = decide(
      input({ total: 50, credibility: 'A', needs: 20, payment: 13, feasibility: 5 }),
    );
    expect(result.decision).toBe('建议暂缓');
    expect(result.reason).toContain('技术可行性');
  });

  it('outranks 开发: an A-grade 85-point idea with a blocked dependency waits', () => {
    expect(
      decisionOf({ total: 85, credibility: 'A', needs: 20, payment: 13, feasibility: 0 }),
    ).toBe('建议暂缓');
  });
});

describe('decide — ④ 建议开发', () => {
  it('develops at exactly 70 points with grade A', () => {
    const result = decide(
      input({ total: 70, credibility: 'A', needs: 20, payment: 13, feasibility: 10 }),
    );
    expect(result.decision).toBe('建议开发');
    expect(result.reason).toContain('总分 70');
    expect(result.nextStep.length).toBeGreaterThan(0);
  });

  it('develops a grade B report without a price at the top of the payment band', () => {
    expect(decisionOf({ total: 85, credibility: 'B', payment: 8 })).toBe('建议开发');
  });

  it('develops needs 13 / payment 17 / total 75 at grade B', () => {
    // The 11–15 needs band with strong payment is B, and B is enough to build.
    const result = decide(
      input({ total: 75, credibility: 'B', needs: 13, payment: 17, feasibility: 10 }),
    );
    expect(result.decision).toBe('建议开发');
    expect(result.reason).toContain('总分 75');
  });
});

describe('decide — the §9 可信度 gate', () => {
  const opportunity = { total: 75, needs: 13, payment: 17, feasibility: 10 } as const;

  it('develops a 75-point opportunity once three sources back it', () => {
    const { grade } = credibility({ ...opportunity, allClaimsCited: true, independentSources: 3 });
    expect(grade).toBe('B');
    expect(decide(input({ ...opportunity, credibility: grade })).decision).toBe('建议开发');
  });

  it('verifies the same 75-point opportunity when only two sources back it', () => {
    const { grade } = credibility({ ...opportunity, allClaimsCited: true, independentSources: 2 });
    expect(grade).toBe('C');
    expect(decide(input({ ...opportunity, credibility: grade })).decision).toBe(
      '建议先验证，再开发',
    );
  });
});

describe('decide — ⑤ 建议先验证，再开发', () => {
  it('verifies at 69 points: one short of the development gate', () => {
    expect(
      decisionOf({ total: 69, credibility: 'A', needs: 20, payment: 13, feasibility: 10 }),
    ).toBe('建议先验证，再开发');
  });

  it('verifies when the total is high but the credibility is only C', () => {
    const result = decide(input({ total: 80, credibility: 'C', payment: 8 }));
    expect(result.decision).toBe('建议先验证，再开发');
    expect(result.reason).toContain('可信度');
  });

  it('verifies a 95-point grade C report instead of developing it', () => {
    expect(decisionOf({ total: 95, credibility: 'C', payment: 8 })).toBe('建议先验证，再开发');
  });

  it('names the cheapest experiment, not a generic next step', () => {
    const { nextStep } = decide(input({ total: 40 }));
    expect(nextStep).toContain('访谈');
    expect(nextStep).toContain('落地页');
    expect(nextStep).toContain('价格测试');
  });
});

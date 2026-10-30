/**
 * Evidence-credibility grade of spec §9. Deliberately independent of the rubric
 * total: a 90-point story built on three uncited posts is still not a grade A,
 * so `decide` reads both numbers instead of ranking on the total alone.
 */

/** Grades are the only four values the spec allows; `reports.credibility_grade` checks them. */
export type CredibilityGrade = 'A' | 'B' | 'C' | 'D';

export interface CredibilityInput {
  /** 真实需求 score (0–20) from `scoreNeeds`. */
  needs: number;
  /** 付费意愿 score (0–20) from `scorePayment`. */
  payment: number;
  /** Every market claim in the report carries an `[eN]` citation. */
  allClaimsCited: boolean;
  /** Distinct sources, i.e. `n` in the aggregate. */
  independentSources: number;
}

export interface Credibility {
  grade: CredibilityGrade;
  /** Why this grade, in the report's language (Chinese). */
  reason: string;
}

/** §9 thresholds; named so the boundaries are stated once. */
const TOP_NEEDS = 16;
const TOP_PAYMENT = 13;
const CITABLE_NEEDS = 11;
const WEAK_NEEDS_MIN = 6;
const WEAK_NEEDS_MAX = 10;
const CROSS_CHECK_SOURCES = 2;

/**
 * Junk input (NaN, ±Infinity, negative) reads as "nothing gathered", never as a
 * pass; a fractional score floors to the rubric's whole points, so no value can
 * slip between two integer bands.
 */
function count(value: number): number {
  return Number.isFinite(value) ? Math.floor(Math.max(0, value)) : 0;
}

/**
 * §9 可信度, evaluated A → B → C → D so an input that satisfies two rows takes
 * the first one the table offers. A is a strict subset of B: B asks only for
 * needs ≥11 plus citations, so payment strength never decides between them in
 * the wrong direction — needs 11–15 with strong payment evidence is a B, not an
 * abandonment. `sources = 0` is the one exception the rows themselves force:
 * D names "no traceable source at all", so the C source floor covers 1–2 rather
 * than 0–2 and a sourceless report can never come out as C.
 */
export function credibility({
  needs,
  payment,
  allClaimsCited,
  independentSources,
}: CredibilityInput): Credibility {
  const needPoints = count(needs);
  const paymentPoints = count(payment);
  const sources = count(independentSources);

  if (needPoints >= TOP_NEEDS && paymentPoints >= TOP_PAYMENT && allClaimsCited) {
    return {
      grade: 'A',
      reason: `需求 ${needPoints} 分、付费 ${paymentPoints} 分，且全部论断有引用`,
    };
  }

  if (needPoints >= CITABLE_NEEDS && allClaimsCited) {
    return {
      grade: 'B',
      reason: `需求 ${needPoints} 分且论断有引用，但未同时满足 A 级门槛（需求 ≥${TOP_NEEDS} 且付费 ≥${TOP_PAYMENT}）`,
    };
  }

  if (needPoints >= WEAK_NEEDS_MIN && needPoints <= WEAK_NEEDS_MAX) {
    return {
      grade: 'C',
      reason: `需求仅 ${needPoints} 分，落在 ${WEAK_NEEDS_MIN}–${WEAK_NEEDS_MAX} 的弱区间`,
    };
  }

  // 1–2 sources: thin, but traceable. Zero is not C — nothing can be checked.
  if (sources >= 1 && sources <= CROSS_CHECK_SOURCES) {
    return {
      grade: 'C',
      reason: `独立来源仅 ${sources} 个（≤${CROSS_CHECK_SOURCES}），无法交叉验证`,
    };
  }

  if (sources === 0) {
    return { grade: 'D', reason: '无任何可追溯来源' };
  }

  if (!allClaimsCited) {
    return {
      grade: 'D',
      reason: `需求 ${needPoints} 分、付费 ${paymentPoints} 分，但论断缺少引用`,
    };
  }

  // Every row above missed, so the needs band is the only thing left: with
  // integer scores it can only be below 6 here.
  return {
    grade: 'D',
    reason: `需求仅 ${needPoints} 分（<${WEAK_NEEDS_MIN}），不足以证明需求存在`,
  };
}

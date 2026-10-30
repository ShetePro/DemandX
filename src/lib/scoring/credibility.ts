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
/** Cross-validation floor: below this the sources are one loud thread, not a market. */
const MIN_GRADED_SOURCES = 3;
/** The C source floor: 1–2 sources are traceable but too thin for an A or a B. */
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
 * the first one the table offers, with one gate in front: no traceable source is
 * D whatever the bands say. A is then a strict subset of B — both require ≥3
 * sources, A adds top needs and top payment — so payment strength never decides
 * between them in the wrong direction, and a high needs score resting on two
 * threads falls to C instead of reaching the development gate.
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

  // Nothing to check: a score with no source is a guess, not a B or a C.
  if (sources === 0) {
    return { grade: 'D', reason: '无任何可追溯来源' };
  }

  if (
    needPoints >= TOP_NEEDS &&
    paymentPoints >= TOP_PAYMENT &&
    allClaimsCited &&
    sources >= MIN_GRADED_SOURCES
  ) {
    return {
      grade: 'A',
      reason: `需求 ${needPoints} 分、付费 ${paymentPoints} 分、独立来源 ${sources} 个，且全部论断有引用`,
    };
  }

  if (needPoints >= CITABLE_NEEDS && allClaimsCited && sources >= MIN_GRADED_SOURCES) {
    return {
      grade: 'B',
      reason: `需求 ${needPoints} 分、论断有引用、独立来源 ${sources} 个，但未同时满足 A 级门槛（需求 ≥${TOP_NEEDS} 且付费 ≥${TOP_PAYMENT}）`,
    };
  }

  if (needPoints >= WEAK_NEEDS_MIN && needPoints <= WEAK_NEEDS_MAX) {
    return {
      grade: 'C',
      reason: `需求仅 ${needPoints} 分，落在 ${WEAK_NEEDS_MIN}–${WEAK_NEEDS_MAX} 的弱区间`,
    };
  }

  // 1–2 sources: traceable but thin, so C caps the grade here.
  if (sources <= CROSS_CHECK_SOURCES) {
    return {
      grade: 'C',
      reason: `独立来源仅 ${sources} 个（≤${CROSS_CHECK_SOURCES}），无法交叉验证`,
    };
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

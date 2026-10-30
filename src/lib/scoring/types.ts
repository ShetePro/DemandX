/**
 * Shared vocabulary of the rubric in spec §9. Scoring happens in code, never in
 * the LLM: the model only picks ordinal tiers and cites evidence ids, and this
 * module's types are the only shape those picks may take.
 */

/** The seven dimensions, in the order the report lists them. */
export const DIMENSIONS = [
  'needs',
  'payment',
  'gap',
  'acquisition',
  'profit',
  'feasibility',
  'longevity',
] as const;

export type Dimension = (typeof DIMENSIONS)[number];

/**
 * Per-dimension ceiling. The values sum to exactly 100, which is what makes
 * `total ≤ 100` structural rather than something to hope for.
 */
export const LIMITS: Record<Dimension, number> = {
  needs: 20,
  payment: 20,
  gap: 15,
  acquisition: 15,
  profit: 15,
  feasibility: 10,
  longevity: 5,
};

/**
 * Counted evidence, deduplicated, as spec §9 defines it.
 *
 * `c` and `comp` are always 0 today: there is no competitor table and no
 * complaint collection source, so the counts were never gathered. `known` says
 * so explicitly — a silent 0 would read as "no competition", which is a
 * fabricated market fact.
 */
export interface Aggregate {
  /** Distinct accepted sources. */
  n: number;
  /** Accepted `paying` evidence rows. */
  p: number;
  /** Direct competitors with an official URL; not collected yet. */
  c: number;
  /** First-hand complaints against a specific competitor; not collected yet. */
  comp: number;
  /** Accepted `recurring` evidence rows. */
  r: number;
  /** At least one accepted `paying` row names a price, so a price page exists. */
  hasVerifiablePrice: boolean;
  /** Which of the unavailable counts were actually collected. */
  known: { competitors: boolean; complaints: boolean };
}

/** Ordinal tier the LLM may pick; the code multiplies it by 5. */
export type Ordinal = 0 | 1 | 2 | 3;

/**
 * Feasibility has no level 3 in spec §9 (all-dependencies-available is the top
 * tier), so its input type stops at 2 instead of being rejected at runtime.
 */
export type OrdinalInput = 0 | 1 | 2;

/** One dimension of the 100-point rubric, traceable to evidence rows. */
export interface DimensionScore {
  dimension: Dimension;
  points: number;
  /** Why the number is what it is, in the report's language (Chinese). */
  rationale: string;
  /** Evidence rows backing the score; empty when the aggregate carries none. */
  evidenceIds: number[];
  /** Set when the inputs were missing rather than zero; surfaced in `unknowns`. */
  unknownReason?: string;
}

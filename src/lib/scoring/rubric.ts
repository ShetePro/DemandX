import {
  LIMITS,
  type Aggregate,
  type Dimension,
  type DimensionScore,
  type Ordinal,
  type OrdinalInput,
} from './types';

/** The dimensions the LLM answers with an ordinal tier instead of a count. */
export type OrdinalDimension = 'acquisition' | 'profit' | 'feasibility';

/**
 * Top tier per ordinal dimension. Feasibility has no level 3 in spec §9: the
 * last tier is "everything is a ready-made API or open-source component", so an
 * out-of-range 3 is truncated to 2 rather than silently scored as 15.
 */
const MAX_ORDINAL: Record<OrdinalDimension, number> = {
  acquisition: 3,
  profit: 3,
  feasibility: 2,
};

/** A non-negative whole count; junk (NaN, negative, fractional) clamps down. */
function tally(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

/** §9 真实需求: independent sources are what separate a signal from one loud thread. */
export function scoreNeeds(n: number): number {
  const count = tally(n);
  if (count >= 10) return 20;
  if (count >= 5) return 16;
  if (count >= 3) return 11;
  if (count >= 1) return 6;
  return 0;
}

/**
 * §9 付费意愿: paid signals without a single checkable price page prove intent,
 * not a budget, so they cap at 10 however many of them there are.
 */
export function scorePayment(p: number, hasVerifiablePrice: boolean): number {
  const count = tally(p);
  const base = count >= 5 ? 20 : count >= 3 ? 17 : count === 2 ? 13 : count === 1 ? 8 : 0;
  if (base === 0 || hasVerifiablePrice) return base;
  return Math.min(base, 10);
}

/**
 * §9 竞品缺口: 10 points for direct competitors plus 5 for their complaints.
 *
 * A part whose counts were never collected contributes 0 — the caller records
 * the matching `unknownReason` so a zero reader cannot be mistaken for "no
 * competition exists".
 */
export function scoreGap(c: number, comp: number, known: Aggregate['known']): number {
  const competitors = tally(c);
  const competitorPart = !known.competitors
    ? 0
    : competitors >= 3
      ? 10
      : competitors === 2
        ? 6
        : competitors === 1
          ? 3
          : 0;

  const complaints = tally(comp);
  const complaintPart = !known.complaints ? 0 : complaints >= 3 ? 5 : complaints >= 1 ? 3 : 0;

  return Math.min(competitorPart + complaintPart, LIMITS.gap);
}

/**
 * §9 ordinal dimensions: the LLM only picks the tier, the code multiplies by 5.
 * No tier evidence or no tier at all scores 0 — a tier is a claim, and a claim
 * without a citation is not admissible.
 */
export function scoreOrdinal(
  dimension: OrdinalDimension,
  ordinal: number | undefined,
  evidenceIds: readonly number[],
): number {
  if (ordinal === undefined || !Number.isFinite(ordinal) || evidenceIds.length === 0) return 0;
  const tier = Math.min(Math.max(Math.floor(ordinal), 0), MAX_ORDINAL[dimension]);
  return Math.min(tier * 5, LIMITS[dimension]);
}

/** §9 长期潜力: sustained use, renewal or churn reasons. */
export function scoreLongevity(r: number): number {
  const count = tally(r);
  if (count >= 3) return 5;
  if (count === 2) return 3;
  if (count === 1) return 2;
  return 0;
}

/** A tier plus the evidence rows that justify it (spec §9 requires ≥1). */
export interface OrdinalChoice<TOrdinal extends number> {
  ordinal: TOrdinal;
  evidenceIds: number[];
}

/** What T5.5 passes in after the LLM answers; every key is optional. */
export interface OrdinalSelections {
  acquisition?: OrdinalChoice<Ordinal>;
  profit?: OrdinalChoice<Ordinal>;
  feasibility?: OrdinalChoice<OrdinalInput>;
}

export interface ScoreInput {
  aggregate: Aggregate;
  /** Omitted keys score 0 and are reported as unknown. */
  ordinals: OrdinalSelections;
}

export interface OpportunityScore {
  /** Always seven entries, in `DIMENSIONS` order. */
  scores: DimensionScore[];
  /** `sum(points)`; never above 100 because each dimension is capped. */
  total: number;
  /** Missing inputs, deduplicated, in report order: `competitors_not_collected` … */
  unknownReasons: string[];
}

/** The counts an ordinal dimension needs from the tier the LLM picked. */
function ordinalUnknownReason(
  dimension: OrdinalDimension,
  choice: OrdinalChoice<number> | undefined,
): string | undefined {
  if (choice === undefined) return `${dimension}_ordinal_missing`;
  if (choice.evidenceIds.length === 0) return `${dimension}_evidence_missing`;
  return undefined;
}

/**
 * Clamps to the dimension ceiling so the rubric total can never exceed 100,
 * whatever a caller hands in.
 */
function dimensionScore(
  dimension: Dimension,
  points: number,
  rationale: string,
  evidenceIds: number[],
  unknownReason?: string,
): DimensionScore {
  const clamped = Math.min(Math.max(Math.round(points), 0), LIMITS[dimension]);
  return {
    dimension,
    points: clamped,
    rationale,
    evidenceIds,
    ...(unknownReason === undefined ? {} : { unknownReason }),
  };
}

/**
 * The whole rubric in one call: seven independent dimensions, each capped by
 * {@link LIMITS}, plus the list of inputs that were missing rather than zero.
 */
export function scoreOpportunity({ aggregate, ordinals }: ScoreInput): OpportunityScore {
  const unknownReasons: string[] = [];
  const scores: DimensionScore[] = [];

  const needsPoints = scoreNeeds(aggregate.n);
  scores.push(dimensionScore('needs', needsPoints, `独立来源 ${tally(aggregate.n)} 个`, []));

  const paymentPoints = scorePayment(aggregate.p, aggregate.hasVerifiablePrice);
  scores.push(
    dimensionScore(
      'payment',
      paymentPoints,
      aggregate.hasVerifiablePrice
        ? `已付费证据 ${tally(aggregate.p)} 条，含可核实价格页`
        : `已付费证据 ${tally(aggregate.p)} 条，无可核实价格页，封顶 10`,
      [],
    ),
  );

  const gapPoints = scoreGap(aggregate.c, aggregate.comp, aggregate.known);
  const gapReason = !aggregate.known.competitors
    ? 'competitors_not_collected'
    : !aggregate.known.complaints
      ? 'complaints_not_collected'
      : undefined;
  if (!aggregate.known.competitors) unknownReasons.push('competitors_not_collected');
  if (!aggregate.known.complaints) unknownReasons.push('complaints_not_collected');
  scores.push(
    dimensionScore(
      'gap',
      gapPoints,
      `直接竞品 ${tally(aggregate.c)} 个、竞品差评 ${tally(aggregate.comp)} 条`,
      [],
      gapReason,
    ),
  );

  const ordinalDimensions: OrdinalDimension[] = ['acquisition', 'profit', 'feasibility'];
  for (const dimension of ordinalDimensions) {
    const choice = ordinals[dimension];
    const points = scoreOrdinal(dimension, choice?.ordinal, choice?.evidenceIds ?? []);
    const reason = ordinalUnknownReason(dimension, choice);
    if (reason !== undefined) unknownReasons.push(reason);
    scores.push(
      dimensionScore(
        dimension,
        points,
        choice === undefined ? '序数缺失' : `${choice.ordinal} 档 × 5 → ${points} 分`,
        choice?.evidenceIds ?? [],
        reason,
      ),
    );
  }

  const longevityPoints = scoreLongevity(aggregate.r);
  scores.push(
    dimensionScore('longevity', longevityPoints, `持续使用证据 ${tally(aggregate.r)} 条`, []),
  );

  return {
    scores,
    total: scores.reduce((sum, score) => sum + score.points, 0),
    unknownReasons: [...new Set(unknownReasons)],
  };
}

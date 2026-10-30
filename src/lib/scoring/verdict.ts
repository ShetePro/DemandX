/**
 * The one place a stored rubric becomes the run's verdict: total, credibility
 * grade and the five-way decision. S4 writes those numbers, S5 re-derives them
 * from the same `scores` rows — sharing this function is what keeps the
 * report's headline from drifting from the scores it claims to sum, and what
 * makes the report model's own opinion irrelevant (it never sees a vote).
 */

import { credibility, type Credibility } from './credibility';
import { decide, type DecisionResult } from './decision';
import type { Dimension, DimensionScore } from './types';

export interface Verdict {
  /** `sum(points)`; the rubric caps every dimension, so this never exceeds 100. */
  total: number;
  credibility: Credibility;
  decision: DecisionResult;
  /** Per-dimension points, keyed by dimension for prompts and the ranking table. */
  points: Record<Dimension, number>;
}

/** A dimension the opportunity never scored reads as 0, not as missing. */
function pointsByDimension(scores: readonly DimensionScore[]): Record<Dimension, number> {
  const points: Record<Dimension, number> = {
    needs: 0,
    payment: 0,
    gap: 0,
    acquisition: 0,
    profit: 0,
    feasibility: 0,
    longevity: 0,
  };

  for (const score of scores) points[score.dimension] = score.points;

  return points;
}

/**
 * `allClaimsCited` is recomputed from the stored rows rather than trusted from
 * an earlier caller: a positive score without an evidence id is exactly what
 * the credibility gate exists to catch.
 */
export function deriveVerdict(
  scores: readonly DimensionScore[],
  independentSources: number,
): Verdict {
  const points = pointsByDimension(scores);
  const total = scores.reduce((sum, score) => sum + score.points, 0);

  const grade = credibility({
    needs: points.needs,
    payment: points.payment,
    allClaimsCited: scores.every((score) => score.points === 0 || score.evidenceIds.length > 0),
    independentSources,
  });

  const decision = decide({
    total,
    credibility: grade.grade,
    needs: points.needs,
    payment: points.payment,
    feasibility: points.feasibility,
  });

  return { total, credibility: grade, decision, points };
}

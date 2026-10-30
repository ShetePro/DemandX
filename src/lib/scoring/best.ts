/**
 * S4's ranking rule, in one place: the report page must show the scores of the
 * opportunity S5 wrote the report from, so both sides call this function
 * instead of each re-stating "highest total wins".
 */

import type { DimensionScore } from './types';

export interface ScoredOpportunity<T> {
  opportunity: T;
  scores: readonly DimensionScore[];
}

export function sumPoints(scores: readonly DimensionScore[]): number {
  return scores.reduce((sum, score) => sum + score.points, 0);
}

/**
 * Highest total wins; a tie goes to the smaller opportunity id, which makes a
 * re-run pick the same opportunity whatever order the rows came back in.
 */
export function pickBestScored<T extends { id: number }>(
  candidates: readonly ScoredOpportunity<T>[],
): ScoredOpportunity<T> | null {
  let best: ScoredOpportunity<T> | null = null;
  let bestTotal = -1;

  for (const candidate of candidates) {
    const total = sumPoints(candidate.scores);
    if (
      best === null ||
      total > bestTotal ||
      (total === bestTotal && candidate.opportunity.id < best.opportunity.id)
    ) {
      best = candidate;
      bestTotal = total;
    }
  }

  return best;
}

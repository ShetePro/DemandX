import { eq } from 'drizzle-orm';

import { db } from '@/lib/db/client';
import { scores } from '@/lib/db/schema';
import { fail, ok, type Result } from '@/lib/quota/types';
import { DIMENSIONS, type Dimension, type DimensionScore } from '@/lib/scoring/types';

/** SQLSTATE only: postgres.js errors also carry query text and parameters. */
function storageFailure<T>(action: string, error: unknown): Result<T> {
  const state = (error as { code?: unknown } | null)?.code;
  const detail = typeof state === 'string' ? ` (SQLSTATE ${state})` : '';
  return fail('STORAGE_FAILED', `${action}失败${detail}`);
}

function isDimension(value: string): value is Dimension {
  return (DIMENSIONS as readonly string[]).includes(value);
}

/**
 * One opportunity's seven rows, in `DIMENSIONS` order so a prompt built from
 * them is reproducible. A row whose dimension is not in the rubric is skipped:
 * only this module writes `scores`, so it can only come from a hand-edited
 * database, and summing an unknown dimension would corrupt the total.
 */
export async function listScores(opportunityId: number): Promise<Result<DimensionScore[]>> {
  try {
    const rows = await db
      .select({
        dimension: scores.dimension,
        points: scores.points,
        rationale: scores.rationale,
        evidenceIds: scores.evidenceIds,
      })
      .from(scores)
      .where(eq(scores.opportunityId, opportunityId));

    const known = rows
      .filter((row) => isDimension(row.dimension))
      .map((row) => ({
        dimension: row.dimension as Dimension,
        points: row.points,
        rationale: row.rationale ?? '',
        evidenceIds: row.evidenceIds ?? [],
      }));

    return ok(
      known.sort((a, b) => DIMENSIONS.indexOf(a.dimension) - DIMENSIONS.indexOf(b.dimension)),
    );
  } catch (error) {
    return storageFailure('读取评分', error);
  }
}

/**
 * Delete-then-insert in one transaction: `scores` is a projection of the stage's
 * latest verdict, never an append-only log. Re-running S4 must leave exactly the
 * seven rows it just computed, not the old seven plus the new ones — and a
 * crash between the two statements must not leave a half-written rubric.
 */
export async function replaceScores(
  opportunityId: number,
  entries: readonly DimensionScore[],
): Promise<Result<void>> {
  try {
    await db.transaction(async (tx) => {
      await tx.delete(scores).where(eq(scores.opportunityId, opportunityId));

      if (entries.length === 0) return;

      await tx.insert(scores).values(
        entries.map((entry) => ({
          opportunityId,
          dimension: entry.dimension,
          points: entry.points,
          rationale: entry.rationale,
          evidenceIds: entry.evidenceIds,
        })),
      );
    });

    return ok(undefined);
  } catch (error) {
    return storageFailure('写入评分', error);
  }
}

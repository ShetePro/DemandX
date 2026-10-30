import { and, asc, eq, isNull } from 'drizzle-orm';

import { db } from '@/lib/db/client';
import { evidence, opportunities, sources } from '@/lib/db/schema';
import type { Signal } from '@/lib/evidence/schema';
import { fail, ok, type Result } from '@/lib/quota/types';

/**
 * One accepted evidence row as S3 sees it: enough to group and name a cluster,
 * never the snapshot text. `sourceId` is what the independence threshold counts;
 * `canonicalUrl` is kept for audits and for telling two pages apart in a log.
 */
export interface AcceptedEvidence {
  id: number;
  signal: Signal;
  platform: string;
  supports: string | null;
  quote: string;
  sourceId: number;
  canonicalUrl: string;
}

/** What S3 persists for one cluster that passed the independence threshold. */
export interface InsertOpportunityInput {
  runId: number;
  name: string;
  positioning: string;
  /** Distinct sources behind `evidenceIds`, counted by the stage, not the model. */
  independentSources: number;
  evidenceIds: number[];
}

/** One stored opportunity, as read back by later stages and the report. */
export interface OpportunityRow {
  id: number;
  runId: number;
  name: string | null;
  positioning: string | null;
  independentSources: number;
  evidenceIds: number[];
}

/** SQLSTATE only: postgres.js errors also carry query text and parameters. */
function storageFailure<T>(action: string, error: unknown): Result<T> {
  const state = (error as { code?: unknown } | null)?.code;
  const detail = typeof state === 'string' ? ` (SQLSTATE ${state})` : '';
  return fail('STORAGE_FAILED', `${action}失败${detail}`);
}

/**
 * Accepted means "not rejected", exactly like `countEvidence`: a row the quote
 * gate or an operator refused must never reach clustering, or the model would
 * be free to build an opportunity on a quote the corpus does not contain.
 *
 * Oldest first: a cluster prompt that reorders its input produces different
 * clusters on a re-run, which makes the stage impossible to compare.
 */
export async function listAcceptedEvidence(runId: number): Promise<Result<AcceptedEvidence[]>> {
  try {
    const rows = await db
      .select({
        id: evidence.id,
        signal: evidence.signal,
        platform: evidence.platform,
        supports: evidence.supports,
        quote: evidence.quote,
        sourceId: evidence.sourceId,
        canonicalUrl: sources.canonicalUrl,
      })
      .from(evidence)
      .innerJoin(sources, eq(evidence.sourceId, sources.id))
      .where(and(eq(evidence.runId, runId), isNull(evidence.rejectedReason)))
      .orderBy(asc(evidence.id));

    return ok(rows.map((row) => ({ ...row, signal: row.signal as Signal })));
  } catch (error) {
    return storageFailure('读取已接受证据', error);
  }
}

/**
 * Store one opportunity. `independent_sources` and `evidence_ids` are written
 * as the stage computed them: the database has no way to recompute either, and
 * later stages must see the exact grounds the decision was made on.
 */
export async function insertOpportunity(
  input: InsertOpportunityInput,
): Promise<Result<{ id: number }>> {
  try {
    const rows = await db
      .insert(opportunities)
      .values({
        runId: input.runId,
        name: input.name,
        positioning: input.positioning,
        independentSources: input.independentSources,
        evidenceIds: input.evidenceIds,
      })
      .returning({ id: opportunities.id });

    const row = rows[0];
    if (!row) return fail('STORAGE_FAILED', '机会已写入但未返回 id');
    return ok({ id: row.id });
  } catch (error) {
    return storageFailure('写入机会', error);
  }
}

/**
 * Every opportunity of one run, oldest first. Order is by id rather than by the
 * independence count: the report ranks opportunities by rubric score later, and
 * a stable order is what makes a re-read comparable.
 */
export async function listOpportunities(runId: number): Promise<Result<OpportunityRow[]>> {
  try {
    const rows = await db
      .select({
        id: opportunities.id,
        runId: opportunities.runId,
        name: opportunities.name,
        positioning: opportunities.positioning,
        independentSources: opportunities.independentSources,
        evidenceIds: opportunities.evidenceIds,
      })
      .from(opportunities)
      .where(eq(opportunities.runId, runId))
      .orderBy(asc(opportunities.id));

    return ok(rows);
  } catch (error) {
    return storageFailure('读取机会', error);
  }
}

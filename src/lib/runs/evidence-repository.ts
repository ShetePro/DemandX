import {
  and,
  asc,
  count,
  desc,
  eq,
  ilike,
  inArray,
  isNotNull,
  isNull,
  notExists,
} from 'drizzle-orm';

import { db } from '@/lib/db/client';
import { evidence, runs, sources } from '@/lib/db/schema';
import type { Signal } from '@/lib/evidence/schema';
import { fail, ok, type Result } from '@/lib/quota/types';
import { parsePriceMention, type PriceMention } from '@/lib/scoring/aggregate';

/** What the extraction stage persists for one candidate quote. */
export interface InsertEvidenceInput {
  runId: number;
  sourceId: number;
  /** Verbatim quote; the quote gate already checked it against the snapshot. */
  quote: string;
  /** Index in the original snapshot text, or `null` for a rejected quote. */
  quoteOffset: number | null;
  platform: string;
  publishedAt: Date | null;
  signal: Signal;
  firstHand: boolean;
  priceMentioned: { amount: number; currency: string } | null;
  supports: string;
  doesNotProve: string;
  /**
   * `null` means accepted (the quote is exact and may be scored). A rejection
   * keeps the row — with its quote and reason — so the evidence page can show
   * what the model tried to pass off as a quote.
   */
  rejectedReason: string | null;
}

/** `id` is always the stored row's id, so a duplicate still resolves to it. */
export type InsertEvidenceOutcome = { id: number; inserted: boolean };

/** One page S2 still has to read: no accepted evidence yet, snapshot on disk. */
export interface ExtractionSource {
  id: number;
  canonicalUrl: string;
  platform: string;
  snapshotPath: string | null;
  contentHash: string;
}

/** SQLSTATE only: postgres.js errors also carry query text and parameters. */
function storageFailure<T>(action: string, error: unknown): Result<T> {
  const state = (error as { code?: unknown } | null)?.code;
  const detail = typeof state === 'string' ? ` (SQLSTATE ${state})` : '';
  return fail('STORAGE_FAILED', `${action}失败${detail}`);
}

/**
 * Persist one candidate. The `(run_id, source_id, quote)` unique index makes
 * the write idempotent: re-extracting a page reports `inserted: false` and the
 * id of the verdict already stored, so a retried stage never double-counts.
 */
export async function insertEvidence(
  input: InsertEvidenceInput,
): Promise<Result<InsertEvidenceOutcome>> {
  try {
    const rows = await db
      .insert(evidence)
      .values({
        runId: input.runId,
        sourceId: input.sourceId,
        quote: input.quote,
        quoteOffset: input.quoteOffset,
        platform: input.platform,
        publishedAt: input.publishedAt,
        signal: input.signal,
        firstHand: input.firstHand,
        priceMentioned: input.priceMentioned,
        supports: input.supports,
        doesNotProve: input.doesNotProve,
        rejectedReason: input.rejectedReason,
      })
      .onConflictDoNothing({
        target: [evidence.runId, evidence.sourceId, evidence.quote],
      })
      .returning({ id: evidence.id });

    const created = rows[0];
    if (created) return ok({ id: created.id, inserted: true });

    const existing = await db
      .select({ id: evidence.id })
      .from(evidence)
      .where(
        and(
          eq(evidence.runId, input.runId),
          eq(evidence.sourceId, input.sourceId),
          eq(evidence.quote, input.quote),
        ),
      )
      .limit(1);

    const row = existing[0];
    // The conflict fired, so the row must exist; a miss here means it was
    // deleted between the two statements.
    if (!row) return fail('STORAGE_FAILED', '证据已存在但读取失败');
    return ok({ id: row.id, inserted: false });
  } catch (error) {
    return storageFailure('写入证据', error);
  }
}

/**
 * Accepted means "not rejected": only a null `rejected_reason` is eligible for
 * scoring, so the two counters partition the run's evidence and can be summed.
 */
export async function countEvidence(
  runId: number,
  filter: { accepted: boolean },
): Promise<Result<number>> {
  try {
    const rows = await db
      .select({ value: count() })
      .from(evidence)
      .where(
        and(
          eq(evidence.runId, runId),
          filter.accepted ? isNull(evidence.rejectedReason) : isNotNull(evidence.rejectedReason),
        ),
      );
    return ok(rows[0]?.value ?? 0);
  } catch (error) {
    return storageFailure('统计证据', error);
  }
}

/**
 * Pages this run has not extracted successfully yet, oldest first. A page with
 * only rejected rows is listed again: the snapshot is unchanged, but a fixed
 * gate or prompt must be able to reconsider it. A page with one accepted row is
 * done — re-reading it would only re-emit the same quotes.
 */
export async function listSourcesForExtraction(
  runId: number,
  limit: number,
): Promise<Result<ExtractionSource[]>> {
  try {
    const rows = await db
      .select({
        id: sources.id,
        canonicalUrl: sources.canonicalUrl,
        platform: sources.platform,
        snapshotPath: sources.snapshotPath,
        contentHash: sources.contentHash,
      })
      .from(sources)
      .where(
        and(
          eq(sources.runId, runId),
          notExists(
            db
              .select({ one: evidence.id })
              .from(evidence)
              .where(and(eq(evidence.sourceId, sources.id), isNull(evidence.rejectedReason))),
          ),
        ),
      )
      .orderBy(asc(sources.id))
      .limit(limit);

    return ok(rows);
  } catch (error) {
    return storageFailure('读取待抽取来源', error);
  }
}

/**
 * One evidence row as the scoring stage needs it: the aggregate counts plus the
 * quote and platform the ordinal prompt shows the model. `rejectedReason` stays
 * in the shape so the stage, not the query, owns what "accepted" means.
 */
export interface ScoringEvidenceRow {
  id: number;
  sourceId: number;
  signal: Signal;
  platform: string;
  quote: string;
  priceMentioned: PriceMention | null;
  rejectedReason: string | null;
  /** What the quote supports, when the report prompt shows it; S4 ignores it. */
  supports?: string | null;
}

/**
 * Evidence rows by id, oldest first so the ordinal prompt is reproducible. An
 * empty list is a valid answer (no query, no rows): an opportunity whose
 * evidence was deleted is scored from nothing rather than failing the stage.
 */
export interface ChatEvidenceFilters {
  signal?: Signal | undefined;
  platform?: string | undefined;
  q?: string | undefined;
}

export interface ChatEvidenceRow {
  id: number;
  platform: string;
  signal: Signal;
  quote: string;
  supports: string | null;
  url: string;
}

/**
 * Evidence for the chat surface, across every run of one conversation. The
 * chat may discuss a rerun that found nothing while an earlier run did find
 * evidence, so scoping to the latest run alone would wrongly return empty.
 */
export async function searchThreadEvidence(
  threadId: number,
  filters: ChatEvidenceFilters = {},
  limit = 8,
): Promise<Result<ChatEvidenceRow[]>> {
  const take = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 20) : 8;

  try {
    const threadRuns = db.select({ id: runs.id }).from(runs).where(eq(runs.threadId, threadId));
    const conditions = [inArray(evidence.runId, threadRuns)];

    if (filters.signal !== undefined) conditions.push(eq(evidence.signal, filters.signal));
    if (filters.platform !== undefined && filters.platform.trim() !== '') {
      conditions.push(ilike(evidence.platform, `%${filters.platform.trim()}%`));
    }
    if (filters.q !== undefined && filters.q.trim() !== '') {
      conditions.push(ilike(evidence.quote, `%${filters.q.trim()}%`));
    }

    const rows = await db
      .select({
        id: evidence.id,
        platform: evidence.platform,
        signal: evidence.signal,
        quote: evidence.quote,
        supports: evidence.supports,
        url: sources.canonicalUrl,
      })
      .from(evidence)
      .innerJoin(sources, eq(sources.id, evidence.sourceId))
      .where(and(...conditions))
      .orderBy(desc(evidence.id))
      .limit(take);

    return ok(rows.map((row) => ({ ...row, signal: row.signal as Signal })));
  } catch (error) {
    return storageFailure('检索证据', error);
  }
}

export async function listEvidenceByIds(
  ids: readonly number[],
): Promise<Result<ScoringEvidenceRow[]>> {
  if (ids.length === 0) return ok([]);

  try {
    const rows = await db
      .select({
        id: evidence.id,
        sourceId: evidence.sourceId,
        signal: evidence.signal,
        platform: evidence.platform,
        quote: evidence.quote,
        priceMentioned: evidence.priceMentioned,
        rejectedReason: evidence.rejectedReason,
        supports: evidence.supports,
      })
      .from(evidence)
      .where(inArray(evidence.id, [...ids]))
      .orderBy(asc(evidence.id));

    return ok(
      rows.map((row) => ({
        ...row,
        signal: row.signal as Signal,
        priceMentioned: parsePriceMention(row.priceMentioned),
      })),
    );
  } catch (error) {
    return storageFailure('读取证据', error);
  }
}

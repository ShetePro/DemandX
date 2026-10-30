import { and, desc, eq, ilike, isNotNull, isNull, or, sql } from 'drizzle-orm';

import { db } from '@/lib/db/client';
import { evidence, sources } from '@/lib/db/schema';
import type { Signal } from '@/lib/evidence/schema';
import { fail, ok, type Result } from '@/lib/quota/types';

/** One page of evidence; the UI never asks for more than this. */
export const EVIDENCE_PAGE_LIMIT = 200;

export type EvidenceStatusFilter = 'accepted' | 'rejected';

/**
 * Filters as they arrive from the URL. Every field is nullable so a cleared
 * param and an absent one mean the same thing: no restriction.
 */
export interface EvidenceQueryFilters {
  signal?: Signal | null;
  platform?: string | null;
  status?: EvidenceStatusFilter | null;
  q?: string | null;
}

export interface EvidenceListItem {
  id: number;
  runId: number;
  quote: string;
  quoteOffset: number | null;
  platform: string;
  publishedAt: Date | null;
  signal: Signal;
  firstHand: boolean;
  priceMentioned: { amount: number; currency: string } | null;
  supports: string | null;
  doesNotProve: string | null;
  rejectedReason: string | null;
  createdAt: Date;
  /** Canonical page the quote was taken from. */
  sourceUrl: string;
  /** Content-addressed snapshot backing the quote (also the highlight source). */
  contentHash: string;
}

export interface EvidenceCounts {
  accepted: number;
  rejected: number;
}

export interface ListEvidenceInput {
  runId: number;
  filters?: EvidenceQueryFilters;
  limit?: number;
}

/** SQLSTATE only: postgres.js errors also carry query text and parameters. */
function storageFailure<T>(action: string, error: unknown): Result<T> {
  const state = (error as { code?: unknown } | null)?.code;
  const detail = typeof state === 'string' ? ` (SQLSTATE ${state})` : '';
  return fail('STORAGE_FAILED', `${action}失败${detail}`);
}

function priceOf(value: unknown): { amount: number; currency: string } | null {
  if (typeof value !== 'object' || value === null) return null;
  const { amount, currency } = value as { amount?: unknown; currency?: unknown };
  if (typeof amount !== 'number' || !Number.isFinite(amount)) return null;
  if (typeof currency !== 'string') return null;
  return { amount, currency };
}

/**
 * Evidence for one run, newest first, joined to the page it came from.
 *
 * Accepted means "not rejected": the status filter partitions on
 * `rejected_reason`, exactly like `countEvidence`, so the table and the two
 * counters can never disagree. The search box matches the quote and the two
 * claim fields; an invalid row is not searched, because it is not evidence.
 */
export async function listEvidence({
  runId,
  filters = {},
  limit = EVIDENCE_PAGE_LIMIT,
}: ListEvidenceInput): Promise<Result<EvidenceListItem[]>> {
  const conditions = [eq(evidence.runId, runId)];

  if (filters.signal) conditions.push(eq(evidence.signal, filters.signal));
  if (filters.platform) conditions.push(eq(evidence.platform, filters.platform));

  if (filters.status === 'accepted') conditions.push(isNull(evidence.rejectedReason));
  if (filters.status === 'rejected') conditions.push(isNotNull(evidence.rejectedReason));

  const search = filters.q?.trim() ?? '';
  if (search !== '') {
    const pattern = `%${search}%`;
    const match = or(
      ilike(evidence.quote, pattern),
      ilike(evidence.supports, pattern),
      ilike(evidence.doesNotProve, pattern),
      ilike(sources.canonicalUrl, pattern),
    );
    if (match) conditions.push(match);
  }

  const cap = Number.isSafeInteger(limit) && limit > 0 ? limit : EVIDENCE_PAGE_LIMIT;

  try {
    const rows = await db
      .select({
        id: evidence.id,
        runId: evidence.runId,
        quote: evidence.quote,
        quoteOffset: evidence.quoteOffset,
        platform: evidence.platform,
        publishedAt: evidence.publishedAt,
        signal: evidence.signal,
        firstHand: evidence.firstHand,
        priceMentioned: evidence.priceMentioned,
        supports: evidence.supports,
        doesNotProve: evidence.doesNotProve,
        rejectedReason: evidence.rejectedReason,
        createdAt: evidence.createdAt,
        sourceUrl: sources.canonicalUrl,
        contentHash: sources.contentHash,
      })
      .from(evidence)
      .innerJoin(sources, eq(evidence.sourceId, sources.id))
      .where(and(...conditions))
      .orderBy(desc(evidence.createdAt), desc(evidence.id))
      .limit(cap);

    return ok(
      rows.map((row) => ({
        ...row,
        signal: row.signal as Signal,
        priceMentioned: priceOf(row.priceMentioned),
      })),
    );
  } catch (error) {
    return storageFailure('读取证据', error);
  }
}

/**
 * The two counters partition the run's evidence: only a null
 * `rejected_reason` is accepted, so `accepted + rejected` is the total.
 */
export async function evidenceCounts(runId: number): Promise<Result<EvidenceCounts>> {
  try {
    const rows = await db
      .select({
        accepted: sql<number>`count(*) filter (where ${evidence.rejectedReason} is null)::int`,
        rejected: sql<number>`count(*) filter (where ${evidence.rejectedReason} is not null)::int`,
      })
      .from(evidence)
      .where(eq(evidence.runId, runId));

    return ok(rows[0] ?? { accepted: 0, rejected: 0 });
  } catch (error) {
    return storageFailure('统计证据', error);
  }
}

/** Distinct platforms present in this run, for the filter select. */
export async function evidencePlatforms(runId: number): Promise<Result<string[]>> {
  try {
    const rows = await db
      .selectDistinct({ platform: evidence.platform })
      .from(evidence)
      .where(eq(evidence.runId, runId))
      .orderBy(evidence.platform);

    return ok(rows.map((row) => row.platform));
  } catch (error) {
    return storageFailure('读取证据平台', error);
  }
}

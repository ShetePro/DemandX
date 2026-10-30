import { and, eq, isNull } from 'drizzle-orm';

import { evidence } from '@/lib/db/schema';
import type { Signal } from '@/lib/evidence/schema';
import { fail, ok, type Result } from '@/lib/quota/types';

import type { Aggregate } from './types';

/** A price the quote states; only its presence matters, never its value. */
export interface PriceMention {
  amount: number;
  currency: string;
}

/**
 * One evidence row as the aggregate sees it. `rejectedReason === null` means the
 * quote passed the gate; rejected rows are still in the input so the pure
 * function, not the caller, owns what "accepted" means.
 */
export interface AggregateEvidenceRow {
  sourceId: number;
  signal: Signal;
  priceMentioned: PriceMention | null;
  rejectedReason: string | null;
}

/**
 * Counts of spec §9, deduplicated. Pure: no IO, no clock, no randomness, so the
 * same rows always produce the same aggregate and every branch is unit-testable.
 *
 * `c` and `comp` stay 0 with `known` false on both: nothing in the pipeline
 * collects competitors or their complaints yet.
 */
export function aggregateEvidence(rows: readonly AggregateEvidenceRow[]): Aggregate {
  const sources = new Set<number>();
  let paying = 0;
  let recurring = 0;
  let hasVerifiablePrice = false;

  for (const row of rows) {
    if (row.rejectedReason !== null) continue;

    sources.add(row.sourceId);

    if (row.signal === 'paying') {
      paying += 1;
      if (row.priceMentioned !== null) hasVerifiablePrice = true;
    }

    if (row.signal === 'recurring') recurring += 1;
  }

  return {
    n: sources.size,
    p: paying,
    c: 0,
    comp: 0,
    r: recurring,
    hasVerifiablePrice,
    known: { competitors: false, complaints: false },
  };
}

/** `jsonb` is `unknown`; a malformed price is "no price", never a crash. */
function toPrice(value: unknown): PriceMention | null {
  if (typeof value !== 'object' || value === null) return null;
  const { amount, currency } = value as { amount?: unknown; currency?: unknown };
  if (typeof amount !== 'number' || !Number.isFinite(amount)) return null;
  if (typeof currency !== 'string' || currency === '') return null;
  return { amount, currency };
}

/** SQLSTATE only: postgres.js errors also carry query text and parameters. */
function storageFailure<T>(action: string, error: unknown): Result<T> {
  const state = (error as { code?: unknown } | null)?.code;
  const detail = typeof state === 'string' ? ` (SQLSTATE ${state})` : '';
  return fail('STORAGE_FAILED', `${action}失败${detail}`);
}

export interface AggregateSource {
  /** Accepted evidence rows of one run, in any order. */
  read(runId: number): Promise<AggregateEvidenceRow[]>;
}

/**
 * The production reader. The db client is imported at call time, not at module
 * load, because it reads `DATABASE_URL` while initialising and throws without
 * it; a static import would make `aggregateEvidence` — and its pure tests —
 * untestable without a database. The specifier stays literal, so the dependency
 * is still visible to bundlers and reviewers.
 */
const fromDatabase: AggregateSource = {
  async read(runId) {
    const { db } = await import('@/lib/db/client');
    const rows = await db
      .select({
        sourceId: evidence.sourceId,
        signal: evidence.signal,
        priceMentioned: evidence.priceMentioned,
        rejectedReason: evidence.rejectedReason,
      })
      .from(evidence)
      .where(and(eq(evidence.runId, runId), isNull(evidence.rejectedReason)));

    // Already filtered in SQL; the pure function re-checks so both paths agree.
    return rows.map((row) => ({
      sourceId: row.sourceId,
      signal: row.signal,
      priceMentioned: toPrice(row.priceMentioned),
      rejectedReason: row.rejectedReason,
    }));
  },
};

/**
 * Aggregates one run's accepted evidence; a query failure comes back as
 * `STORAGE_FAILED` so S4 can degrade instead of crashing the worker.
 * `source` is injectable so the failure path is testable without a database.
 */
export async function loadAggregate(
  runId: number,
  source: AggregateSource = fromDatabase,
): Promise<Result<Aggregate>> {
  try {
    return ok(aggregateEvidence(await source.read(runId)));
  } catch (error) {
    return storageFailure('证据聚合', error);
  }
}

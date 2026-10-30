import { and, count, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';

import { db } from '@/lib/db/client';
import { queries, runEvents, sources } from '@/lib/db/schema';
import { fail, ok, type Result } from '@/lib/quota/types';

/** Everything S1 knows about a fetched page at insert time. */
export interface InsertSourceInput {
  runId: number;
  /** Dedupe key, already canonicalised by `canonicalizeUrl`. */
  canonicalUrl: string;
  platform: string;
  /** SHA-256 of the snapshot text; `(url, hash)` is the table's identity. */
  contentHash: string;
  snapshotPath?: string | null;
  httpStatus?: number | null;
  crawlTier?: string | null;
  fetchedAt?: Date;
}

/** `id` is always the stored row's id, so a duplicate still points at the snapshot. */
export type InsertSourceOutcome = { id: number; inserted: boolean };

/** SQLSTATE only: postgres.js errors also carry query text and parameters. */
function storageFailure<T>(action: string, error: unknown): Result<T> {
  const state = (error as { code?: unknown } | null)?.code;
  const detail = typeof state === 'string' ? ` (SQLSTATE ${state})` : '';
  return fail('STORAGE_FAILED', `${action}失败${detail}`);
}

/**
 * Insert one source, relying on the `(canonical_url, content_hash)` unique index
 * for idempotency: re-crawling unchanged content is a no-op that reports
 * `inserted: false` and the existing row's id.
 */
export async function insertSource(input: InsertSourceInput): Promise<Result<InsertSourceOutcome>> {
  try {
    const rows = await db
      .insert(sources)
      .values({
        runId: input.runId,
        canonicalUrl: input.canonicalUrl,
        platform: input.platform,
        contentHash: input.contentHash,
        ...(input.snapshotPath === undefined ? {} : { snapshotPath: input.snapshotPath }),
        ...(input.httpStatus === undefined ? {} : { httpStatus: input.httpStatus }),
        ...(input.crawlTier === undefined ? {} : { crawlTier: input.crawlTier }),
        ...(input.fetchedAt === undefined ? {} : { fetchedAt: input.fetchedAt }),
      })
      .onConflictDoNothing({ target: [sources.canonicalUrl, sources.contentHash] })
      .returning({ id: sources.id });

    const created = rows[0];
    if (created) return ok({ id: created.id, inserted: true });

    const existing = await db
      .select({ id: sources.id })
      .from(sources)
      .where(
        and(
          eq(sources.canonicalUrl, input.canonicalUrl),
          eq(sources.contentHash, input.contentHash),
        ),
      )
      .limit(1);

    const row = existing[0];
    // The conflict fired, so the row must exist; a miss here means it was
    // deleted between the two statements.
    if (!row) return fail('STORAGE_FAILED', '来源已存在但读取失败');
    return ok({ id: row.id, inserted: false });
  } catch (error) {
    return storageFailure('写入来源', error);
  }
}

/** How many sources this run has stored. */
export async function countSources(runId: number): Promise<Result<number>> {
  try {
    const rows = await db.select({ value: count() }).from(sources).where(eq(sources.runId, runId));
    return ok(rows[0]?.value ?? 0);
  } catch (error) {
    return storageFailure('统计来源', error);
  }
}

/**
 * Canonical URLs this run already has, for cross-query dedupe. Distinct: a page
 * whose content changed appears once even though it has two rows.
 */
export async function listSourceUrls(runId: number): Promise<Result<string[]>> {
  try {
    const rows = await db
      .selectDistinct({ url: sources.canonicalUrl })
      .from(sources)
      .where(eq(sources.runId, runId));
    return ok(rows.map((row) => row.url));
  } catch (error) {
    return storageFailure('读取来源 URL', error);
  }
}

/** One issued search query, kept for auditability. */
export interface RecordQueryInput {
  runId: number;
  angle: string;
  provider: string;
  text: string;
  resultCount: number;
}

export async function recordQuery(input: RecordQueryInput): Promise<Result<{ id: number }>> {
  try {
    const rows = await db
      .insert(queries)
      .values({
        runId: input.runId,
        angle: input.angle,
        provider: input.provider,
        text: input.text,
        resultCount: input.resultCount,
      })
      .returning({ id: queries.id });

    const row = rows[0];
    if (!row) return fail('STORAGE_FAILED', '写入查询失败');
    return ok({ id: row.id });
  } catch (error) {
    return storageFailure('写入查询', error);
  }
}

/** One audit row of S1's search log, as the monitor page renders it. */
export interface QueryRecord {
  id: number;
  angle: string | null;
  provider: string | null;
  text: string | null;
  resultCount: number;
  createdAt: Date;
}

/** Every query the run issued, oldest first. */
export async function listQueries(runId: number): Promise<Result<QueryRecord[]>> {
  if (!Number.isInteger(runId) || runId <= 0) return ok([]);

  try {
    const rows = await db
      .select({
        id: queries.id,
        angle: queries.angle,
        provider: queries.provider,
        text: queries.text,
        resultCount: queries.resultCount,
        createdAt: queries.createdAt,
      })
      .from(queries)
      .where(eq(queries.runId, runId))
      .orderBy(queries.id);

    return ok(rows);
  } catch (error) {
    return storageFailure('读取查询记录', error);
  }
}

const SOURCE_EVENT_TYPES = ['source.needs_human', 'source.failed', 'source.skipped'] as const;

export interface SourceReasonCount {
  reason: string;
  count: number;
}

/**
 * How much of S1 did not land, counted over the whole event log. The monitor
 * needs a total, not "whatever fits in one page of events", so the database
 * groups them; the client only adds the events that arrive after first paint.
 */
export interface SourceEventSummary {
  needsHuman: number;
  failed: number;
  skipped: number;
  capped: boolean;
  /** The page budget S1 hit, when it hit one. */
  cappedMaxPages: number | null;
  /** Skip reasons, most frequent first. */
  reasons: SourceReasonCount[];
}

export function emptySourceEventSummary(): SourceEventSummary {
  return {
    needsHuman: 0,
    failed: 0,
    skipped: 0,
    capped: false,
    cappedMaxPages: null,
    reasons: [],
  };
}

export async function summarizeSourceEvents(runId: number): Promise<Result<SourceEventSummary>> {
  if (!Number.isInteger(runId) || runId <= 0) return ok(emptySourceEventSummary());

  try {
    const rows = await db.execute<{ type: string; reason: string | null; count: number }>(sql`
      select type,
             coalesce(payload->>'reason', payload->>'code') as reason,
             count(*)::int as count
      from run_events
      where run_id = ${runId}
        and type in ('source.needs_human', 'source.failed', 'source.skipped')
      group by type, reason
      order by count desc, reason asc
    `);

    const summary = emptySourceEventSummary();
    const reasons = new Map<string, number>();

    for (const row of rows) {
      if (row.type === 'source.needs_human') {
        summary.needsHuman += row.count;
      } else if (row.type === 'source.failed') {
        summary.failed += row.count;
      } else if (row.type === 'source.skipped') {
        summary.skipped += row.count;
        const reason = row.reason ?? 'unknown';
        reasons.set(reason, (reasons.get(reason) ?? 0) + row.count);
      }
    }

    summary.reasons = [...reasons.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((left, right) => right.count - left.count || left.reason.localeCompare(right.reason));

    const capped = await db.execute<{ count: number; max_pages: number | null }>(sql`
      select count(*)::int as count,
             max((payload->>'maxPages')::int) as max_pages
      from run_events
      where run_id = ${runId} and type = 'stage.capped'
    `);
    const cappedRow = capped[0];
    summary.capped = (cappedRow?.count ?? 0) > 0;
    summary.cappedMaxPages = cappedRow?.max_pages ?? null;

    return ok(summary);
  } catch (error) {
    return storageFailure('统计采集事件', error);
  }
}

const sourceEventPayloadSchema = z.object({
  url: z.string().optional(),
  platform: z.string().optional(),
  reason: z.string().optional(),
  code: z.string().optional(),
});

/** One failed/skipped/queued page, newest first. */
export interface RecentSourceEvent {
  eventId: number;
  type: string;
  url: string | null;
  platform: string | null;
  reason: string | null;
  createdAt: Date;
}

export async function listRecentSourceEvents(
  runId: number,
  limit = 10,
): Promise<Result<RecentSourceEvent[]>> {
  if (!Number.isInteger(runId) || runId <= 0) return ok([]);
  const capped = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 50) : 10;

  try {
    const rows = await db
      .select({
        eventId: runEvents.id,
        type: runEvents.type,
        payload: runEvents.payload,
        createdAt: runEvents.createdAt,
      })
      .from(runEvents)
      .where(and(eq(runEvents.runId, runId), inArray(runEvents.type, [...SOURCE_EVENT_TYPES])))
      .orderBy(desc(runEvents.id))
      .limit(capped);

    return ok(
      rows.map((row) => {
        const parsed = sourceEventPayloadSchema.safeParse(row.payload);
        const fields = parsed.success ? parsed.data : {};
        return {
          eventId: row.eventId,
          type: row.type,
          url: fields.url ?? null,
          platform: fields.platform ?? null,
          reason: fields.reason ?? fields.code ?? null,
          createdAt: row.createdAt,
        };
      }),
    );
  } catch (error) {
    return storageFailure('读取采集事件', error);
  }
}

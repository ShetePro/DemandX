import { and, count, eq } from 'drizzle-orm';

import { db } from '@/lib/db/client';
import { queries, sources } from '@/lib/db/schema';
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

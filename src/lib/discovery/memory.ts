import { desc } from 'drizzle-orm';

import { db } from '@/lib/db/client';
import { discoveryFeedback, discoveryScans } from '@/lib/db/schema';

import { fingerprintToText, opportunityFingerprint } from './novelty';
import type { DiscoveryPlan, DiscoveryResult, ScanMemory } from './types';

/** How many past scans the planner is allowed to read. */
export const MEMORY_SCANS = 12;
/** Scans whose source URLs are excluded from the next search. */
export const EXCLUDE_SCANS = 8;
/** Cap on the exclusion set: a hard bound on request size, not a policy. */
export const MAX_EXCLUDED_URLS = 300;
/** Feedback rows read back for the planner. */
export const ADOPTED_LIMIT = 30;

export type MemoryResult<T> = { ok: true; value: T } | { ok: false; message: string };

function storageMessage(action: string, error: unknown): string {
  const state = (error as { code?: unknown } | null)?.code;
  const detail = typeof state === 'string' ? ` (SQLSTATE ${state})` : '';
  return `${action}失败${detail}`;
}

/**
 * Everything the next scan must know: what previous rounds looked like, which
 * directions were adopted, and which URLs are now stale. Read failure is not
 * silently treated as "no history" — the caller decides whether to scan
 * without memory, and the UI reports it.
 */
export async function loadScanMemory(): Promise<MemoryResult<ScanMemory>> {
  try {
    const [scanRows, feedbackRows] = await Promise.all([
      db.select().from(discoveryScans).orderBy(desc(discoveryScans.id)).limit(MEMORY_SCANS),
      db.select().from(discoveryFeedback).orderBy(desc(discoveryFeedback.id)).limit(ADOPTED_LIMIT),
    ]);

    const excluded: string[] = [];
    for (const row of scanRows.slice(0, EXCLUDE_SCANS)) {
      for (const url of row.sourceUrls) {
        if (excluded.length >= MAX_EXCLUDED_URLS) break;
        if (!excluded.includes(url)) excluded.push(url);
      }
    }

    return {
      ok: true,
      value: {
        scans: scanRows.map((row) => ({
          angles: row.angles,
          queries: row.queries,
          opportunities: row.opportunities.map((item) => ({
            title: item.title,
            angle: item.angle,
            fingerprint: item.fingerprint,
          })),
          createdAt: row.createdAt.toISOString(),
        })),
        adopted: feedbackRows.map((row) => ({ title: row.opportunityTitle, angle: row.angle })),
        excludedUrls: excluded,
      },
    };
  } catch (error) {
    return { ok: false, message: storageMessage('读取灵感雷达记忆', error) };
  }
}

/** Fingerprints of every remembered opportunity, newest rounds first. */
export function priorFingerprints(memory: ScanMemory): string[] {
  return memory.scans.flatMap((scan) => scan.opportunities.map((item) => item.fingerprint));
}

export async function recordScan(input: {
  plan: DiscoveryPlan;
  /** Queries actually executed, when the scan added fallback probes. */
  queries: readonly string[];
  result: Pick<DiscoveryResult, 'sources' | 'opportunities' | 'elapsedMs' | 'model'>;
  trendTitles: readonly string[];
}): Promise<MemoryResult<number>> {
  try {
    const rows = await db
      .insert(discoveryScans)
      .values({
        angles: input.plan.angles,
        queries: [...input.queries],
        sourceUrls: input.result.sources.map((source) => source.url),
        opportunities: input.result.opportunities.map((opportunity) => ({
          title: opportunity.title,
          problem: opportunity.problem,
          angle: opportunity.angle,
          fingerprint: fingerprintToText(
            opportunityFingerprint(opportunity.title, opportunity.problem),
          ),
        })),
        trendTitles: [...input.trendTitles],
        strategy: input.plan.strategy,
        model: input.result.model,
        elapsedMs: input.result.elapsedMs,
      })
      .returning({ id: discoveryScans.id });

    const row = rows[0];
    if (row === undefined) return { ok: false, message: '写入灵感雷达记忆失败：没有返回行' };
    return { ok: true, value: row.id };
  } catch (error) {
    return { ok: false, message: storageMessage('写入灵感雷达记忆', error) };
  }
}

/**
 * Records that the operator started researching a discovered direction. This
 * is the radar's only learning signal; the write is best-effort but its
 * failure is reported so the operator knows the next round cannot use it.
 */
export async function recordFeedback(input: {
  scanId: number | null;
  opportunityTitle: string;
  angle?: string | null;
  threadId: number;
}): Promise<MemoryResult<null>> {
  try {
    await db.insert(discoveryFeedback).values({
      scanId: input.scanId,
      opportunityTitle: input.opportunityTitle,
      angle: input.angle ?? null,
      threadId: input.threadId,
    });
    return { ok: true, value: null };
  } catch (error) {
    return { ok: false, message: storageMessage('写入灵感反馈', error) };
  }
}

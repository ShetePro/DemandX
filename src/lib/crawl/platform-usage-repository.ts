import { desc, gte } from 'drizzle-orm';

import { db } from '@/lib/db/client';
import { sources } from '@/lib/db/schema';
import { ok, type Result } from '@/lib/quota/types';

import { summarizePlatformUsage, type PlatformUsage } from './platform-usage';

/**
 * Sources whose URL belongs to a logged-in platform, over the recent window.
 * The search adapters themselves are web/HN/Reddit/GitHub; a platform count
 * here means a search result actually pointed at that domain and the crawler
 * used its profile.
 */
export async function readPlatformUsage(days = 30): Promise<Result<PlatformUsage[]>> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  try {
    const rows = await db
      .select({
        url: sources.canonicalUrl,
        tier: sources.crawlTier,
        runId: sources.runId,
        fetchedAt: sources.fetchedAt,
      })
      .from(sources)
      .where(gte(sources.fetchedAt, since))
      .orderBy(desc(sources.fetchedAt))
      .limit(5_000);

    return ok(summarizePlatformUsage(rows));
  } catch (error) {
    const state = (error as { code?: unknown } | null)?.code;
    const detail = typeof state === 'string' ? ` (SQLSTATE ${state})` : '';
    return { ok: false, code: 'STORAGE_FAILED', message: `读取平台采集统计失败${detail}` };
  }
}

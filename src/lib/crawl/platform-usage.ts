import { platformForUrl } from './platform-profile';
import { PLATFORMS } from './session-status';

/** One platform's crawled pages; zero pages is a meaningful answer. */
export interface PlatformUsage {
  platform: string;
  pages: number;
  runs: number;
  lastFetchedAt: Date | null;
  /** `static` / `browser` / `snippet` counts, so the tier is visible too. */
  tiers: Record<string, number>;
}

export interface UsageRow {
  url: string;
  tier: string | null;
  runId: number;
  fetchedAt: Date | null;
}

/** Pure grouping; the page queries rows and this decides what they mean. */
export function summarizePlatformUsage(rows: readonly UsageRow[]): PlatformUsage[] {
  const byPlatform = new Map<string, PlatformUsage>();
  for (const platform of PLATFORMS) {
    byPlatform.set(platform, {
      platform,
      pages: 0,
      runs: 0,
      lastFetchedAt: null,
      tiers: {},
    });
  }
  const runIds = new Map<string, Set<number>>();

  for (const row of rows) {
    const platform = platformForUrl(row.url);
    if (platform === null) continue;
    const entry = byPlatform.get(platform);
    if (entry === undefined) continue;

    entry.pages += 1;
    const tier = row.tier ?? 'unknown';
    entry.tiers[tier] = (entry.tiers[tier] ?? 0) + 1;
    if (row.fetchedAt !== null && (entry.lastFetchedAt === null || row.fetchedAt > entry.lastFetchedAt)) {
      entry.lastFetchedAt = row.fetchedAt;
    }
    const runs = runIds.get(platform) ?? new Set<number>();
    runs.add(row.runId);
    runIds.set(platform, runs);
  }

  for (const [platform, entry] of byPlatform) {
    entry.runs = runIds.get(platform)?.size ?? 0;
  }
  return [...byPlatform.values()];
}

import { asc, desc } from 'drizzle-orm';

import { db } from '@/lib/db/client';
import { providerUsage, providers } from '@/lib/db/schema';

import type { ProviderUsageSummary, Result } from './types';

/** SQLSTATE only: postgres.js errors also carry query text and parameters. */
function storageFailure<T>(action: string, error: unknown): Result<T> {
  const state = (error as { code?: unknown } | null)?.code;
  const detail = typeof state === 'string' ? ` (SQLSTATE ${state})` : '';
  return { ok: false, code: 'STORAGE_FAILED', message: `${action}失败${detail}` };
}

function emptySummary(providerId: number): ProviderUsageSummary {
  return {
    providerId,
    fiveHourRequests: 0,
    weeklyRequests: 0,
    monthlyRequests: 0,
    monthlyPromptTokens: 0,
    monthlyCompletionTokens: 0,
    monthlySpendUsd: 0,
  };
}

/**
 * The newest counter per provider/window. `provider_usage` is an append-only
 * ledger of windows, so summing every row would count old windows as current;
 * the latest `window_start` is the rolling figure the quota guard reads.
 * Providers without any row are returned with zeros, never omitted.
 */
export async function getProviderUsage(): Promise<Result<ProviderUsageSummary[]>> {
  try {
    const [providerRows, usageRows] = await Promise.all([
      db.select({ id: providers.id }).from(providers).orderBy(asc(providers.id)),
      db
        .select({
          providerId: providerUsage.providerId,
          window: providerUsage.window,
          windowStart: providerUsage.windowStart,
          requests: providerUsage.requests,
          promptTokens: providerUsage.promptTokens,
          completionTokens: providerUsage.completionTokens,
          allowanceUsd: providerUsage.allowanceUsd,
        })
        .from(providerUsage)
        .orderBy(desc(providerUsage.windowStart)),
    ]);

    const summaries = new Map<number, ProviderUsageSummary>();
    for (const provider of providerRows) {
      summaries.set(provider.id, emptySummary(provider.id));
    }

    // Rows arrive newest-first, so the first row seen for a window wins.
    const seen = new Set<string>();
    for (const row of usageRows) {
      const key = `${row.providerId}:${row.window}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const summary = summaries.get(row.providerId) ?? emptySummary(row.providerId);
      switch (row.window) {
        case '5h':
          summary.fiveHourRequests = row.requests;
          break;
        case 'weekly':
          summary.weeklyRequests = row.requests;
          break;
        case 'monthly':
          summary.monthlyRequests = row.requests;
          summary.monthlyPromptTokens = row.promptTokens;
          summary.monthlyCompletionTokens = row.completionTokens;
          summary.monthlySpendUsd = Number(row.allowanceUsd);
          break;
        default:
          // `day` is a valid column value but has no bar in the settings panel.
          break;
      }
      summaries.set(row.providerId, summary);
    }

    return { ok: true, value: [...summaries.values()] };
  } catch (error) {
    return storageFailure('读取 provider 用量', error);
  }
}

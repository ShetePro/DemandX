import { sql } from 'drizzle-orm';

import { USAGE_WINDOWS, usageWindowStart } from './usage-windows';

import { db } from '@/lib/db/client';
import { apiCalls, providerUsage } from '@/lib/db/schema';

export interface RecordLlmUsageInput {
  providerId: number;
  model: string;
  kind: string;
  promptTokens: number;
  completionTokens: number;
  runId?: number | null;
  now?: Date;
}

/**
 * Every successful model call lands in two places: the per-call ledger
 * (`api_calls`) and the rolling counters the settings page shows. The counter
 * is an upsert on (provider, window, start), so concurrent calls from the
 * worker cannot overwrite each other; the token columns are summed the same
 * way, which is why they are `sql` expressions rather than read-modify-write.
 *
 * A failed write must never fail the model call that already succeeded: the
 * error is logged and swallowed.
 */
export async function recordLlmUsage(input: RecordLlmUsageInput): Promise<void> {
  const now = input.now ?? new Date();
  const promptTokens = Math.max(0, Math.trunc(input.promptTokens));
  const completionTokens = Math.max(0, Math.trunc(input.completionTokens));

  try {
    await db.insert(apiCalls).values({
      providerId: input.providerId,
      runId: input.runId ?? null,
      model: input.model,
      kind: input.kind,
      promptTokens,
      completionTokens,
    });

    for (const window of USAGE_WINDOWS) {
      const windowStart = usageWindowStart(now, window);
      await db
        .insert(providerUsage)
        .values({
          providerId: input.providerId,
          window,
          windowStart,
          requests: 1,
          promptTokens,
          completionTokens,
          allowanceUsd: '0',
        })
        .onConflictDoUpdate({
          target: [providerUsage.providerId, providerUsage.window, providerUsage.windowStart],
          set: {
            requests: sql`${providerUsage.requests} + 1`,
            promptTokens: sql`${providerUsage.promptTokens} + ${promptTokens}`,
            completionTokens: sql`${providerUsage.completionTokens} + ${completionTokens}`,
          },
        });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`⚠️ 模型用量写入失败：${message}`);
  }
}

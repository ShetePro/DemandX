import { and, asc, eq } from 'drizzle-orm';

import { db } from '@/lib/db/client';
import { llmChains, providers } from '@/lib/db/schema';

import type { ChainItem, Profile } from './port';
import type { ProviderKind, Result } from './types';

/** SQLSTATE only: postgres.js errors also carry query text and parameters. */
function storageFailure<T>(action: string, error: unknown): Result<T> {
  const state = (error as { code?: unknown } | null)?.code;
  const detail = typeof state === 'string' ? ` (SQLSTATE ${state})` : '';
  return { ok: false, code: 'STORAGE_FAILED', message: `${action}失败${detail}` };
}

/**
 * The chain a profile actually runs on, in `position` order. Disabled providers
 * are filtered out rather than returning an error: turning one off is how an
 * operator takes it out of service. An empty chain means "not configured yet".
 */
export async function getChain(profile: Profile): Promise<Result<ChainItem[]>> {
  try {
    const rows = await db
      .select({
        providerId: providers.id,
        providerName: providers.name,
        kind: providers.kind,
        baseUrl: providers.baseUrl,
        modelId: llmChains.modelId,
      })
      .from(llmChains)
      .innerJoin(providers, eq(providers.id, llmChains.providerId))
      .where(and(eq(llmChains.profile, profile), eq(providers.enabled, true)))
      .orderBy(asc(llmChains.position));

    return {
      ok: true,
      value: rows.map((row) => ({
        providerId: row.providerId,
        providerName: row.providerName,
        kind: row.kind as ProviderKind,
        baseUrl: row.baseUrl,
        modelId: row.modelId,
      })),
    };
  } catch (error) {
    return storageFailure(`读取 ${profile} 链`, error);
  }
}

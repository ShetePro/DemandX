import { and, asc, eq, inArray } from 'drizzle-orm';

import { db } from '@/lib/db/client';
import { llmChains, providerModels, providers } from '@/lib/db/schema';

import type { ChainItem, Profile } from './port';
import type { ProviderKind, Result } from './types';

const PROFILES: readonly Profile[] = ['bulk', 'quality'];

/** SQLSTATE only: postgres.js errors also carry query text and parameters. */
function storageFailure<T>(action: string, error: unknown): Result<T> {
  const state = (error as { code?: unknown } | null)?.code;
  const detail = typeof state === 'string' ? ` (SQLSTATE ${state})` : '';
  return { ok: false, code: 'STORAGE_FAILED', message: `${action}失败${detail}` };
}

function fail<T>(message: string): Result<T> {
  return { ok: false, code: 'VALIDATION_FAILED', message };
}

export type ChainEntry = { providerId: number; modelId: string };

/** What `saveChains` writes: every profile replaced as a whole. */
export type ChainsInput = Record<Profile, ChainEntry[]>;

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

/**
 * Replace both chains in one transaction. Every entry must name an enabled
 * provider and a model that provider exposes to outside clients: a chain the
 * port cannot serve is refused now, not at the first run. Positions restart at
 * 0 for each profile.
 */
export async function saveChains(input: ChainsInput): Promise<Result<void>> {
  const entries = PROFILES.flatMap((profile) =>
    input[profile].map((entry, position) => ({ ...entry, profile, position })),
  );

  for (const profile of PROFILES) {
    if (input[profile].length === 0) return fail(`${profile} 链不能为空`);
  }

  const providerIds = [...new Set(entries.map((entry) => entry.providerId))];

  try {
    return await db.transaction(async (tx) => {
      const providerRows = await tx
        .select({ id: providers.id, enabled: providers.enabled })
        .from(providers)
        .where(inArray(providers.id, providerIds));
      const providersById = new Map(providerRows.map((row) => [row.id, row]));

      const modelRows = await tx
        .select({ providerId: providerModels.providerId, modelId: providerModels.modelId })
        .from(providerModels)
        .where(
          and(
            inArray(providerModels.providerId, providerIds),
            eq(providerModels.availableExternally, true),
          ),
        );
      const usableModels = new Set(modelRows.map((row) => `${row.providerId}:${row.modelId}`));

      for (const entry of entries) {
        const where = `${entry.profile}#${entry.position}`;
        const provider = providersById.get(entry.providerId);
        if (!provider) return fail(`${where}：provider ${entry.providerId} 不存在`);
        if (provider.enabled !== true) {
          return fail(`${where}：provider ${entry.providerId} 已停用，不能加入链`);
        }
        if (!usableModels.has(`${entry.providerId}:${entry.modelId}`)) {
          return fail(`${where}：模型 ${entry.modelId} 不在该 provider 的可用模型列表中`);
        }
      }

      // Validation runs first, so a rejected save leaves both chains untouched.
      await tx.delete(llmChains).where(inArray(llmChains.profile, PROFILES));
      await tx.insert(llmChains).values(
        entries.map((entry) => ({
          profile: entry.profile,
          position: entry.position,
          providerId: entry.providerId,
          modelId: entry.modelId,
        })),
      );

      return { ok: true, value: undefined };
    });
  } catch (error) {
    return storageFailure('保存 LLM 链路 ', error);
  }
}

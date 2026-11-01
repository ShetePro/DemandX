'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import {
  createResolvedWebSearchPort,
  encryptWebSearchKey,
  resolveWebSearch,
  storedWebSearchSchema,
} from '@/lib/search/web-search-config';
import { getSetting, setSetting } from '@/lib/settings/store';
import {
  WEB_SEARCH_SETTINGS_KEY,
  webSearchSettingsSchema,
  type WebSearchSettings,
} from '@/lib/settings/web-search-settings';

import type { CrawlActionResult } from './actions';

const CRAWL_PATH = '/settings/crawl';

const saveInputSchema = webSearchSettingsSchema.extend({
  /** Empty means "keep the stored key"; the form never receives the key back. */
  apiKey: z.string().trim().max(400, 'API Key 过长').optional(),
});

export type WebSearchStatus = {
  settings: WebSearchSettings;
  /** Masked key, e.g. `sk-…abcd`; null when nothing is stored. */
  keyHint: string | null;
  /** True when the worker would currently find a key in settings or env. */
  configured: boolean;
};

function failure(code: 'VALIDATION_FAILED' | 'STORAGE_FAILED', message: string) {
  return { ok: false as const, code, message };
}

export async function getWebSearchSettingsAction(): Promise<CrawlActionResult<WebSearchStatus>> {
  const stored = await getSetting(WEB_SEARCH_SETTINGS_KEY, storedWebSearchSchema);
  if (!stored.ok) return failure(stored.code, stored.message);

  const settings = webSearchSettingsSchema.parse({
    enabled: stored.value?.enabled ?? false,
    provider: stored.value?.provider ?? 'tavily',
    maxResults: stored.value?.maxResults ?? 5,
  });
  const resolved = await resolveWebSearch();

  return {
    ok: true,
    value: {
      settings,
      keyHint: stored.value?.apiKeyHint ?? null,
      configured: resolved.ok && resolved.value !== null,
    },
  };
}

/**
 * Saves the fallback search configuration. The key is encrypted before it is
 * stored, and an empty field keeps the existing key so the operator can change
 * the provider without re-entering a secret.
 */
export async function saveWebSearchSettingsAction(
  raw: unknown,
): Promise<CrawlActionResult<{ settings: WebSearchSettings; keyHint: string | null }>> {
  const parsed = saveInputSchema.safeParse(raw);
  if (!parsed.success) {
    return failure(
      'VALIDATION_FAILED',
      parsed.error.issues.map((issue) => issue.message).join('; '),
    );
  }

  const existing = await getSetting(WEB_SEARCH_SETTINGS_KEY, storedWebSearchSchema);
  if (!existing.ok) return failure(existing.code, existing.message);

  let apiKeyCt = existing.value?.apiKeyCt;
  let apiKeyHint = existing.value?.apiKeyHint;

  const plainKey = parsed.data.apiKey ?? '';
  if (plainKey !== '') {
    const encrypted = encryptWebSearchKey(plainKey);
    if (!encrypted.ok) return failure('STORAGE_FAILED', encrypted.message);
    apiKeyCt = encrypted.apiKeyCt;
    apiKeyHint = encrypted.apiKeyHint;
  }

  const envKey = process.env.WEB_SEARCH_API_KEY?.trim() ?? '';
  if (parsed.data.enabled && apiKeyCt === undefined && envKey === '') {
    return failure('VALIDATION_FAILED', '启用兜底搜索前请填写 API Key（或在环境变量中配置）');
  }

  const settings: WebSearchSettings = {
    enabled: parsed.data.enabled,
    provider: parsed.data.provider,
    maxResults: parsed.data.maxResults,
  };

  const saved = await setSetting(WEB_SEARCH_SETTINGS_KEY, {
    ...settings,
    ...(apiKeyCt === undefined ? {} : { apiKeyCt }),
    ...(apiKeyHint === undefined ? {} : { apiKeyHint }),
  });
  if (!saved.ok) return failure(saved.code, saved.message);

  revalidatePath(CRAWL_PATH);
  return { ok: true, value: { settings, keyHint: apiKeyHint ?? null } };
}

/** Removes the stored key and switches the fallback off; env keys still apply. */
export async function clearWebSearchKeyAction(): Promise<CrawlActionResult<{ cleared: true }>> {
  const existing = await getSetting(WEB_SEARCH_SETTINGS_KEY, storedWebSearchSchema);
  if (!existing.ok) return failure(existing.code, existing.message);

  const settings = webSearchSettingsSchema.parse({
    enabled: existing.value?.enabled ?? false,
    provider: existing.value?.provider ?? 'tavily',
    maxResults: existing.value?.maxResults ?? 5,
  });
  const saved = await setSetting(WEB_SEARCH_SETTINGS_KEY, { ...settings, enabled: false });
  if (!saved.ok) return failure(saved.code, saved.message);

  revalidatePath(CRAWL_PATH);
  return { ok: true, value: { cleared: true } };
}

/**
 * One real query against the configured provider. This is the availability
 * proof the settings page offers: constructing the adapter says nothing about
 * the key, network or quota, actually searching does.
 */
export async function testWebSearchAction(): Promise<
  CrawlActionResult<{ provider: string; hits: number }>
> {
  const resolved = await resolveWebSearch();
  if (!resolved.ok) return failure('VALIDATION_FAILED', resolved.message);
  if (resolved.value === null) return failure('VALIDATION_FAILED', '未配置兜底搜索');

  try {
    const hits = await createResolvedWebSearchPort(resolved.value).search('独立开发者 工具 付费', {
      limit: 3,
    });
    return {
      ok: true,
      value: { provider: resolved.value.provider, hits: hits.length },
    };
  } catch (error) {
    return failure(
      'VALIDATION_FAILED',
      `搜索失败：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

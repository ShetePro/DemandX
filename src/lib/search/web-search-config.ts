import { z } from 'zod';

import { loadSecretBox } from '@/lib/crypto/secret';
import { getSetting } from '@/lib/settings/store';
import {
  WEB_SEARCH_SETTINGS_KEY,
  webSearchSettingsSchema,
  type WebSearchSettings,
} from '@/lib/settings/web-search-settings';

import { WEB_SEARCH_PROVIDERS, type WebSearchProvider, type SearchPort } from './port';
import { createWebApiSearch } from './web-api';

/** Stored shape: the form fields plus the encrypted key and its readable mask. */
export const storedWebSearchSchema = webSearchSettingsSchema.extend({
  apiKeyCt: z.string().min(1).optional(),
  apiKeyHint: z.string().max(64).optional(),
});

export type StoredWebSearch = z.output<typeof storedWebSearchSchema>;

export type ResolvedWebSearch = {
  provider: WebSearchProvider;
  apiKey: string;
  /** Where the key came from, so the worker log can explain the choice. */
  source: 'settings' | 'env';
};

const envProviderSchema = z.enum(WEB_SEARCH_PROVIDERS);

/**
 * Resolve the fallback search without ever putting the key in client state.
 * Settings win over env so an operator can rotate the key from the UI, while a
 * deployment that only sets env vars keeps working with no row at all.
 */
export async function resolveWebSearch(): Promise<
  { ok: true; value: ResolvedWebSearch | null } | { ok: false; message: string }
> {
  const stored = await getSetting(WEB_SEARCH_SETTINGS_KEY, storedWebSearchSchema);
  if (!stored.ok) return { ok: false, message: stored.message };

  if (stored.value?.enabled === true && stored.value.apiKeyCt !== undefined) {
    try {
      return {
        ok: true,
        value: {
          provider: stored.value.provider,
          apiKey: loadSecretBox().decrypt(stored.value.apiKeyCt),
          source: 'settings',
        },
      };
    } catch (error) {
      return {
        ok: false,
        message: `兜底搜索密钥无法解密：${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  const envKey = process.env.WEB_SEARCH_API_KEY?.trim() ?? '';
  if (envKey === '') return { ok: true, value: null };

  const provider = envProviderSchema.safeParse(process.env.WEB_SEARCH_PROVIDER?.trim());
  if (!provider.success) {
    return {
      ok: false,
      message: `WEB_SEARCH_PROVIDER 必须是 ${WEB_SEARCH_PROVIDERS.join(' / ')} 之一`,
    };
  }

  return { ok: true, value: { provider: provider.data, apiKey: envKey, source: 'env' } };
}

/** Builds the fallback port; the pipeline only calls it when primaries are empty. */
export function createResolvedWebSearchPort(config: ResolvedWebSearch): SearchPort {
  const baseUrl = process.env.WEB_SEARCH_BASE_URL?.trim();
  return createWebApiSearch({
    provider: config.provider,
    apiKey: config.apiKey,
    ...(baseUrl === undefined || baseUrl === '' ? {} : { baseUrl }),
  });
}

/** Encrypts a new key and derives the mask shown back in the settings form. */
export function encryptWebSearchKey(
  plain: string,
): { ok: true; apiKeyCt: string; apiKeyHint: string } | { ok: false; message: string } {
  try {
    const box = loadSecretBox();
    return { ok: true, apiKeyCt: box.encrypt(plain), apiKeyHint: box.mask(plain) };
  } catch (error) {
    return {
      ok: false,
      message: `无法加密搜索密钥：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export function readStoredWebSearch(value: unknown): WebSearchSettings {
  return webSearchSettingsSchema.parse(value);
}

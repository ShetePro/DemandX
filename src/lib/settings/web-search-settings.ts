import { z } from 'zod';

import { WEB_SEARCH_PROVIDERS } from '@/lib/search/port';

/** Namespace for the operator-configured fallback search. */
export const WEB_SEARCH_SETTINGS_KEY = 'web-search';

/**
 * Form-facing shape: never contains the key itself. The encrypted key and its
 * mask live under the same row but are written by the server action only, so a
 * client that round-trips this object cannot leak or erase it.
 */
export const webSearchSettingsSchema = z.strictObject({
  /** Off by default: a fallback that silently spends an API quota is a surprise. */
  enabled: z.boolean().default(false),
  provider: z.enum(WEB_SEARCH_PROVIDERS).default('tavily'),
  /** Hits requested per query from the provider, independent of S1's crawl cap. */
  maxResults: z
    .number()
    .int('结果条数必须是整数')
    .min(3, '至少 3 条')
    .max(10, '最多 10 条')
    .default(5),
});

export type WebSearchSettings = z.output<typeof webSearchSettingsSchema>;

export const DEFAULT_WEB_SEARCH_SETTINGS: WebSearchSettings = webSearchSettingsSchema.parse({});

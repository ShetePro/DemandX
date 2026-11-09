import { createHnCommentSearch } from '@/lib/discovery/hn-comments';
import { createLlmPort } from '@/lib/llm/chain';
import { getChain } from '@/lib/llm/chain-repository';
import { resolveApiKey } from '@/lib/llm/repository';
import { recordLlmUsage } from '@/lib/llm/usage-recorder';
import { createBingSearch } from '@/lib/search/bing';
import { createGitHubSearch } from '@/lib/search/github';
import { createRateLimiter } from '@/lib/search/limiter';
import { createRedditSearch } from '@/lib/search/reddit';
import { createSocialSearch } from '@/lib/search/social';
import type { SearchPort } from '@/lib/search/port';
import { createResolvedWebSearchPort, resolveWebSearch } from '@/lib/search/web-search-config';

import type { DiscoveryPorts } from './find';

/**
 * Shared construction for the action and the streaming route: both must search
 * with the same ports and record model usage identically.
 */
export async function createDiscoveryRuntime(): Promise<
  Pick<DiscoveryPorts, 'searchPorts' | 'llm'>
> {
  // Discovery is an interactive scan, not a crawl: a short per-host gap keeps
  // ten queries inside the dialog's lifetime.
  const limiter = createRateLimiter({ rps: 2, minDelayMs: 300, maxDelayMs: 800 });
  const deps = { limiter };
  const searchPorts: SearchPort[] = [
    createHnCommentSearch(deps),
    createBingSearch(deps),
    // First-hand demand on slow, rate-limited platforms: a few queries each.
    createRedditSearch(deps),
    { ...createGitHubSearch(deps), maxQueries: 4 },
    // Logged-in platforms: one Chinese/English query each, headed browser.
    // A missing profile returns no hits without launching anything.
    createSocialSearch('zhihu'),
    createSocialSearch('xiaohongshu'),
    createSocialSearch('douyin'),
    createSocialSearch('twitter'),
  ];

  const webSearch = await resolveWebSearch();
  if (webSearch.ok && webSearch.value !== null) {
    searchPorts.push(createResolvedWebSearchPort(webSearch.value, deps));
  }

  const llm = createLlmPort({
    loadChain: getChain,
    resolveApiKey,
    recordUsage: (item, usage) =>
      void recordLlmUsage({
        providerId: item.providerId,
        model: item.modelId,
        kind: item.kind,
        promptTokens: usage.in,
        completionTokens: usage.out,
      }),
  });

  return { searchPorts, llm };
}

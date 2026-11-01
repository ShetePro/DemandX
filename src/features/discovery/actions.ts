'use server';

import { z } from 'zod';

import { findOpportunities } from '@/lib/discovery/find';
import type { DiscoveryResult } from '@/lib/discovery/types';
import { createLlmPort } from '@/lib/llm/chain';
import { getChain } from '@/lib/llm/chain-repository';
import { resolveApiKey } from '@/lib/llm/repository';
import { recordLlmUsage } from '@/lib/llm/usage-recorder';
import { createResearch, type CreateResearchResult } from '@/lib/runs/repository';
import { enqueueS1 } from '@/lib/runs/queue';
import { createBingSearch } from '@/lib/search/bing';
import { createHnCommentSearch } from '@/lib/discovery/hn-comments';
import { createRateLimiter } from '@/lib/search/limiter';
import { createResolvedWebSearchPort, resolveWebSearch } from '@/lib/search/web-search-config';

export type DiscoveryActionResult<T> =
  { ok: true; value: T } | { ok: false; code: DiscoveryErrorCode; message: string };

export type DiscoveryErrorCode =
  | 'VALIDATION_FAILED'
  | 'NO_SOURCES'
  | 'LLM_UNAVAILABLE'
  | 'INVALID_OUTPUT'
  | 'STORAGE_FAILED'
  | 'QUEUE_FAILED';

/**
 * One scan for product opportunities. Only snippets are searched (no crawl);
 * the keyed fallback is appended when configured, so a blocked scraper does
 * not turn discovery into an error.
 */
const findInputSchema = z
  .object({
    /** URLs an earlier scan already showed; the rescan must look elsewhere. */
    excludeUrls: z.array(z.string().trim().max(2000)).max(300, '最多排除 300 条来源').optional(),
  })
  .strict();

export async function findOpportunitiesAction(
  raw?: unknown,
): Promise<DiscoveryActionResult<DiscoveryResult>> {
  const parsed = findInputSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    return { ok: false, code: 'VALIDATION_FAILED', message: '扫描参数无效' };
  }

  // Discovery is an interactive scan, not a crawl: keep the per-host gap short
  // enough that eight bilingual queries finish while the dialog is open.
  const limiter = createRateLimiter({ rps: 2, minDelayMs: 300, maxDelayMs: 800 });
  const deps = { limiter };
  // Discovery prefers real discussion over scraped advice pages: HN comments
  // are structured and reliable, Bing covers Chinese vertical queries, and the
  // keyed API (when configured) outranks both.
  const ports = [createHnCommentSearch(deps), createBingSearch(deps)];

  const webSearch = await resolveWebSearch();
  if (webSearch.ok && webSearch.value !== null) {
    ports.push(createResolvedWebSearchPort(webSearch.value, deps));
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
  const result = await findOpportunities({
    searchPorts: ports,
    llm,
    excludeUrls: parsed.data.excludeUrls ?? [],
  });
  if (!result.ok) return { ok: false, code: result.code, message: result.message };
  return { ok: true, value: result.value };
}

const ideaSchema = z.string().trim().min(8, '想法至少 8 个字符').max(4000, '想法最多 4000 个字符');

/**
 * Turns a discovered opportunity into a normal research thread: same repository
 * path as the new-research composer, so the run, first message and queue entry
 * are indistinguishable from a typed idea.
 */
export async function startDiscoveredResearchAction(
  idea: unknown,
): Promise<DiscoveryActionResult<CreateResearchResult>> {
  const parsed = ideaSchema.safeParse(idea);
  if (!parsed.success) {
    return {
      ok: false,
      code: 'VALIDATION_FAILED',
      message: parsed.error.issues[0]?.message ?? '想法无效',
    };
  }

  const created = await createResearch({ idea: parsed.data });
  if (!created.ok) {
    return { ok: false, code: 'STORAGE_FAILED', message: created.message };
  }

  const queued = await enqueueS1(created.value.runId);
  if (!queued.ok) {
    return { ok: false, code: 'QUEUE_FAILED', message: queued.message };
  }

  return { ok: true, value: created.value };
}

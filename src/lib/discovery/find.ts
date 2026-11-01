import type { LlmPort } from '@/lib/llm/port';
import type { SearchPort } from '@/lib/search/port';

import { DISCOVERY_HITS_PER_QUERY, DISCOVERY_QUERIES } from './queries';
import {
  discoverySchema,
  type DiscoveryResult,
  type DiscoverySource,
  type Opportunity,
} from './types';

/** Enough context for the model without turning the prompt into a crawl. */
export const MAX_SOURCES = 18;

/**
 * Discovery is an interactive scan: a model that has not answered in this long
 * is better reported as unavailable than left spinning behind the dialog.
 */
export const DISCOVERY_LLM_TIMEOUT_MS = 45_000;

export type DiscoveryPorts = {
  /** Scraped engines and the keyed fallback, already ordered by preference. */
  searchPorts: readonly SearchPort[];
  llm: LlmPort;
};

export type DiscoveryOutcome =
  | { ok: true; value: DiscoveryResult }
  | { ok: false; code: 'NO_SOURCES' | 'LLM_UNAVAILABLE' | 'INVALID_OUTPUT'; message: string };

/**
 * Uses the same phrase-shaped queries as S0, but stops at snippets: discovery
 * is a lead generator, not evidence. Crawling a page here would spend the
 * operator's crawl budget before the user has chosen an idea.
 */
export async function findOpportunities(deps: DiscoveryPorts): Promise<DiscoveryOutcome> {
  // Queries run together: discovery is interactive, and the adapters' shared
  // limiter already serialises calls per host, so this does not burst.
  const perQuery = await Promise.all(
    DISCOVERY_QUERIES.map(async (query) => {
      const answered: {
        provider: string;
        hits: { url: string; title: string; snippet: string; platform: string }[];
      }[] = [];

      for (const port of deps.searchPorts) {
        try {
          const hits = await port.search(query, { limit: DISCOVERY_HITS_PER_QUERY });
          if (hits.length === 0) continue;
          answered.push({
            provider: port.id,
            hits: hits.map((hit) => ({
              url: hit.url,
              title: hit.title,
              snippet: hit.snippet,
              platform: hit.platform,
            })),
          });
        } catch {
          // A blocked engine is expected; the next port (or the keyed fallback)
          // gets the same query. Only a total wash-out fails the scan.
        }
      }

      return answered;
    }),
  );

  const sources: DiscoverySource[] = [];
  const seen = new Set<string>();
  const providers = new Set<string>();

  for (const answered of perQuery) {
    for (const { provider, hits } of answered) {
      if (sources.length >= MAX_SOURCES) break;
      providers.add(provider);

      for (const hit of hits) {
        if (sources.length >= MAX_SOURCES) break;
        if (seen.has(hit.url)) continue;
        seen.add(hit.url);
        sources.push(hit);
      }
    }
  }

  if (sources.length === 0) {
    return {
      ok: false,
      code: 'NO_SOURCES',
      message: '所有搜索源都没有返回结果：检查网络、平台会话或兜底搜索配置。',
    };
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const asked = await Promise.race([
    deps.llm.structured(discoverySchema, buildPrompt(sources), { profile: 'bulk' }),
    new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), DISCOVERY_LLM_TIMEOUT_MS);
    }),
  ]).finally(() => clearTimeout(timer));

  if (asked === null) {
    return {
      ok: false,
      code: 'LLM_UNAVAILABLE',
      message: '模型响应超时，请重试（本次扫描未完成）。',
    };
  }
  if (!asked.ok) {
    return { ok: false, code: 'LLM_UNAVAILABLE', message: `机会分析失败：${asked.message}` };
  }

  const allowed = new Set(sources.map((source) => source.url));
  const opportunities: Opportunity[] = [];
  for (const candidate of asked.value.data.opportunities) {
    // The model may copy a URL it was not given; such a citation cannot be
    // verified, so the whole candidate is dropped rather than shipped.
    const evidence = candidate.evidence.filter((item) => allowed.has(item.url));
    if (evidence.length === 0) continue;
    opportunities.push({ ...candidate, evidence });
  }

  if (opportunities.length === 0) {
    return {
      ok: false,
      code: 'INVALID_OUTPUT',
      message: '模型没有给出可核对的证据链接，本次扫描作废。',
    };
  }

  return {
    ok: true,
    value: { sources, opportunities, providers: [...providers] },
  };
}

function buildPrompt(sources: readonly DiscoverySource[]): { system: string; user: string } {
  const list = sources
    .map(
      (source, index) =>
        `[${index + 1}] ${source.title}\nURL: ${source.url}\n片段: ${source.snippet.slice(0, 300)}`,
    )
    .join('\n\n');

  return {
    system: `你是独立开发者的机会侦察员。只根据给定片段判断，不得补充搜索。
输出 1–5 个值得验证的产品机会，每个机会必须引用片段里的 URL，并给出原文短句作为 quote。
要求：
- problem 写用户的原话困境，不是功能清单。
- signal 只能是 problem / seeking / paying / switching / recurring。
- 片段之间互相矛盾或只是同一来源的重复，不要当成多个机会。
- 如果证据只够支撑“有人在抱怨”，就如实写成 problem；不要升级为付费需求。
- 全部用中文。`,
    user: `候选片段：\n\n${list}\n\n请输出 opportunities 数组。`,
  };
}

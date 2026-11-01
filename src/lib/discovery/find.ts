import type { LlmPort } from '@/lib/llm/port';
import type { SearchPort } from '@/lib/search/port';

import { DISCOVERY_HITS_PER_QUERY, pickDiscoveryQueries } from './queries';
import { hasBusinessSignal, quoteGrounded, selectSources } from './sources';
import {
  discoverySchema,
  type DiscoveryResult,
  type DiscoverySource,
  type Opportunity,
} from './types';

/** Enough context for the model without turning the prompt into a crawl. */
export const MAX_SOURCES = 30;

/** At least this many sources must survive filtering, or the scan is too thin. */
export const MIN_SOURCES = 5;

/**
 * Discovery is an interactive scan: a model that has not answered in this long
 * is better reported as unavailable than left spinning behind the dialog.
 */
export const DISCOVERY_LLM_TIMEOUT_MS = 45_000;

export type DiscoveryPorts = {
  /** Scraped engines and the keyed fallback, already ordered by preference. */
  searchPorts: readonly SearchPort[];
  llm: LlmPort;
  /** Injected so tests can pin the sampled queries. */
  random?: () => number;
  /** Sources an earlier scan already used; a rescan must not repeat them. */
  excludeUrls?: readonly string[];
  /** Injected queries (tests); production samples the pool instead. */
  queries?: readonly string[];
  /** Streaming progress: search → filter → model. */
  onPhase?: (phase: 'search' | 'filter' | 'model', detail?: number) => void;
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
  const startedAt = Date.now();
  deps.onPhase?.('search');
  const excluded = new Set(deps.excludeUrls ?? []);
  const queries = deps.queries ?? pickDiscoveryQueries(undefined, deps.random);

  // Queries run together: discovery is interactive, and the adapters' shared
  // limiter already serialises calls per host, so this does not burst.
  const perQuery = await Promise.all(
    queries.map(async (query) => {
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

  const candidates: { source: DiscoverySource; query: string }[] = [];
  const providers = new Set<string>();

  perQuery.forEach((answered, index) => {
    const query = queries[index] ?? '';
    for (const { provider, hits } of answered) {
      providers.add(provider);
      for (const hit of hits) {
        if (excluded.has(hit.url)) continue;
        candidates.push({ source: hit, query });
      }
    }
  });

  // Relevance gate: blocked farms, non-commercial strangers and near-duplicate
  // pages are removed before the model ever sees them.
  deps.onPhase?.('filter');
  const sources = selectSources(candidates, MAX_SOURCES);
  deps.onPhase?.('filter', sources.length);

  if (sources.length < MIN_SOURCES) {
    return {
      ok: false,
      code: 'NO_SOURCES',
      message: `通过商业相关性筛选的片段只有 ${sources.length} 条，样本不足：换一轮或检查搜索配置。`,
    };
  }

  deps.onPhase?.('model', sources.length);

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
    return {
      ok: false,
      code: 'LLM_UNAVAILABLE',
      message: `灵感分析失败：${asked.message}${failureHint(asked.message)}`,
    };
  }

  const allowed = new Map(sources.map((source) => [source.url, source]));
  const opportunities: Opportunity[] = [];
  for (const candidate of asked.value.data.opportunities) {
    // The model may copy a URL it was not given; such a citation cannot be
    // verified, so the whole candidate is dropped rather than shipped.
    const seenUrls = new Set<string>();
    const evidence = candidate.evidence.filter((item) => {
      const source = allowed.get(item.url);
      if (source === undefined || seenUrls.has(item.url)) return false;
      // The quote must exist in the source: URL-only citations let a model
      // attach a fabricated sentence to a real page.
      if (!quoteGrounded(item.quote, `${source.title}\n${source.snippet}`)) return false;
      seenUrls.add(item.url);
      return true;
    });
    if (evidence.length === 0) continue;

    // Commercial anchoring: at least one cited page must talk about money,
    // hiring or a paid alternative. Without it the idea is just a complaint.
    const anchored = evidence.some((item) => {
      const source = allowed.get(item.url);
      return source !== undefined && hasBusinessSignal(`${source.title}\n${source.snippet}`);
    });
    if (!anchored) continue;

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
    value: {
      sources,
      opportunities,
      providers: [...providers],
      elapsedMs: Date.now() - startedAt,
      model: asked.value.used.modelId,
    },
  };
}

/**
 * Turns the chain's terse codes into something the operator can act on: a
 * `network` failure is local connectivity, a `cooldown` means the provider was
 * marked unhealthy and will be skipped for a while.
 */
function failureHint(message: string): string {
  const hints: string[] = [];
  if (/network|fetch failed|adapter/i.test(message)) {
    hints.push('network 通常是到 provider 的网络或代理中断，已自动重试一次');
  }
  if (/cooldown/i.test(message)) {
    hints.push(
      'cooldown 表示该 provider 刚失败过，会跳过约 5 分钟；可在 /settings/llm 切换链后再试',
    );
  }
  return hints.length === 0 ? '' : `（${hints.join('；')}）`;
}

function buildPrompt(sources: readonly DiscoverySource[]): { system: string; user: string } {
  const list = sources
    .map(
      (source, index) =>
        `[${index + 1}] ${source.title}\nURL: ${source.url}\n片段: ${source.snippet.slice(0, 300)}`,
    )
    .join('\n\n');

  return {
    system: `你是独立开发者的灵感侦察员。只根据给定片段判断，不得补充搜索。
输出 4–8 个值得验证的产品灵感，尽量覆盖不同领域（中文与海外各至少两个），不要反复描述同一个问题来凑数；每条都必须引用片段里的 URL，并给出原文短句作为 quote。
要求：
- problem 写用户的原话困境，不是功能清单。
- signal 只能是 problem / seeking / paying / switching / recurring。
- currentAlternative 写用户现在怎么解决；competitors 只写片段里点名的产品或服务，没有就空数组。
- monetization 只能是 subscription / usage / one-time / service。
- mvp 写一个人 1–2 周能上线的范围；需要牌照、硬件、双边市场或大规模数据的想法不要输出。
- 证据里至少一条必须包含价格、付费、招聘、外包或替代方案等商业信息；只有情绪、没有商业线索的灵感不要输出。
- 片段之间互相矛盾或只是同一来源的重复，不要当成多个灵感。
- 全部用中文。`,
    user: `候选片段：\n\n${list}\n\n请输出 opportunities 数组。`,
  };
}

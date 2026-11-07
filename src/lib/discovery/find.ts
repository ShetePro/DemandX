import type { LlmPort } from '@/lib/llm/port';
import type { SearchPort } from '@/lib/search/port';

import { resolvePlannedAngle } from './angles';
import { isNovelFingerprint, opportunityFingerprint } from './novelty';
import { DISCOVERY_HITS_PER_QUERY, pickDiscoveryQueries } from './queries';
import { hasBusinessSignal, quoteGrounded, selectSources } from './sources';
import {
  discoverySchema,
  type DiscoveryPlan,
  type DiscoverySource,
  type Opportunity,
} from './types';

/** Enough context for the model without turning the prompt into a crawl. */
export const MAX_SOURCES = 30;

/**
 * At least this many sources must survive filtering, or the scan is too thin.
 * Two still refuses a scan built on one lucky link, while the quote, angle and
 * novelty gates keep a thin result honest.
 */
export const MIN_SOURCES = 2;

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
  /** This round's angles and queries; without it the static pool is used. */
  plan?: DiscoveryPlan | undefined;
  /** Fingerprints of recent opportunities; near-duplicates are dropped. */
  priorFingerprints?: readonly string[] | undefined;
  /** Streaming progress: search → filter → model. */
  onPhase?: (phase: 'search' | 'filter' | 'model', detail?: number) => void;
};

/** The scan's own findings; the route adds memory and novelty metadata. */
export interface DiscoveryValue {
  sources: DiscoverySource[];
  opportunities: Opportunity[];
  providers: string[];
  elapsedMs: number;
  model: string;
}

export type DiscoveryOutcome =
  | { ok: true; value: DiscoveryValue }
  | {
      ok: false;
      code: 'NO_SOURCES' | 'LLM_UNAVAILABLE' | 'INVALID_OUTPUT' | 'TOO_SIMILAR';
      message: string;
    };

/**
 * Uses the same phrase-shaped queries as S0, but stops at snippets: discovery
 * is a lead generator, not evidence. Crawling a page here would spend the
 * operator's crawl budget before the user has chosen an idea.
 */
export async function findOpportunities(deps: DiscoveryPorts): Promise<DiscoveryOutcome> {
  const startedAt = Date.now();
  deps.onPhase?.('search');
  const excluded = new Set(deps.excludeUrls ?? []);
  const queries = [
    ...new Set(
      deps.queries ??
        deps.plan?.queries.map((item) => item.query) ??
        pickDiscoveryQueries(undefined, deps.random),
    ),
  ];
  const angles = deps.plan?.angles ?? [];
  const allowedAngles = new Set(angles);
  const prior = deps.priorFingerprints ?? [];

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

  async function askModel(prompt: { system: string; user: string }) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const answered = await Promise.race([
      deps.llm.structured(discoverySchema, prompt, { profile: 'bulk' }),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), DISCOVERY_LLM_TIMEOUT_MS);
      }),
    ]).finally(() => clearTimeout(timer));
    return answered;
  }

  const allowed = new Map(sources.map((source) => [source.url, source]));
  const check = (candidates: readonly Opportunity[]) =>
    validateCandidates(candidates, { allowed, angles, allowedAngles, prior });

  let asked = await askModel(buildPrompt(sources, angles));
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

  let checked = check(asked.value.data.opportunities);

  // A model that ignored the evidence rules gets one corrective retry on the
  // same snippets: replanning costs a search round and may not fix the cause.
  if (
    checked.opportunities.length === 0 &&
    (checked.ungrounded > 0 || checked.unanchored > 0)
  ) {
    const problems = [
      checked.ungrounded > 0 ? `${checked.ungrounded} 条灵感的 quote 在片段里找不到原文` : '',
      checked.unanchored > 0 ? `${checked.unanchored} 条灵感没有引用带「商业线索」标记的片段` : '',
    ]
      .filter((problem) => problem !== '')
      .join('；');

    const retry = await askModel(
      buildPrompt(
        sources,
        angles,
        `${problems}。这一轮 quote 必须逐字来自片段，并且每条灵感至少引用一条带「商业线索」标记的片段；做不到就不要输出该条。`,
      ),
    );
    if (retry !== null && retry.ok) {
      const second = check(retry.value.data.opportunities);
      if (second.opportunities.length > 0) {
        asked = retry;
        checked = second;
      }
    }
  }

  const { opportunities, duplicates, offAngle, ungrounded, unanchored } = checked;

  if (opportunities.length === 0) {
    if (duplicates > 0) {
      return {
        ok: false,
        code: 'TOO_SIMILAR',
        message: `本轮 ${duplicates} 个方向与最近扫描重复，已丢弃；换一个角度重试。`,
      };
    }
    return {
      ok: false,
      code: 'INVALID_OUTPUT',
      message: `模型输出未通过校验：引文不匹配 ${ungrounded}、缺少商业线索 ${unanchored}、角度不符 ${offAngle}，本次扫描作废。`,
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

function buildPrompt(
  sources: readonly DiscoverySource[],
  angles: readonly string[],
  hint?: string,
): { system: string; user: string } {
  const businessIndexes = sources.flatMap((source, index) =>
    hasBusinessSignal(`${source.title}\n${source.snippet}`) ? [index + 1] : [],
  );

  const list = sources
    .map((source, index) => {
      const business = businessIndexes.includes(index + 1) ? '[商业线索] ' : '';
      return `[${index + 1}] ${business}${source.title}\nURL: ${source.url}\n片段: ${source.snippet.slice(0, 300)}`;
    })
    .join('\n\n');

  const requiredSources =
    businessIndexes.length === 0
      ? '（本轮没有含商业线索的片段）'
      : businessIndexes.map((index) => `[${index}]`).join(' ');

  const angleRule =
    angles.length === 0
      ? '每条灵感都要带 angle，用一个能说明买家与工作流的短标签。'
      : `本轮的 angle 只能从以下列表里取，且尽量让不同灵感落在不同角度上：\n${angles
          .map((angle) => `- ${angle}`)
          .join('\n')}`;

  return {
    system: `你是独立开发者的灵感侦察员。只根据给定片段判断，不得补充搜索。
输出 4–8 个值得验证的产品灵感，尽量覆盖不同领域（中文与海外各至少两个），不要反复描述同一个问题来凑数；每条都必须引用片段里的 URL，并给出原文短句作为 quote。
要求：
- problem 写用户的原话困境，不是功能清单。
- ${angleRule}
- signal 只能是 problem / seeking / paying / switching / recurring。
- currentAlternative 写用户现在怎么解决；competitors 只写片段里点名的产品或服务，没有就空数组。
- monetization 只能是 subscription / usage / one-time / service。
- mvp 写一个人 1–2 周能上线的范围；需要牌照、硬件、双边市场或大规模数据的想法不要输出。
- 每条灵感的 evidence 至少引用一条下方「必选证据来源」里的编号；这些片段含价格、付费、招聘、外包或替代方案。没有商业线索可引用就不要输出这条灵感。
- 片段之间互相矛盾或只是同一来源的重复，不要当成多个灵感。
- 全部用中文。${hint === undefined ? '' : `\n\n上一轮的问题：${hint}`}`,
    user: `必选证据来源（含商业线索）：${requiredSources}\n\n候选片段：\n\n${list}\n\n请输出 opportunities 数组。`,
  };
}

type CandidateCheck = {
  opportunities: Opportunity[];
  duplicates: number;
  offAngle: number;
  ungrounded: number;
  unanchored: number;
};

/**
 * Evidence gates for one model answer: angle membership, citation grounding,
 * a commercial anchor, and cross-scan novelty. Counts are returned even when
 * nothing survives, so the caller can explain the failure and correct it.
 */
function validateCandidates(
  candidates: readonly Opportunity[],
  context: {
    allowed: ReadonlyMap<string, DiscoverySource>;
    angles: readonly string[];
    allowedAngles: ReadonlySet<string>;
    prior: readonly string[];
  },
): CandidateCheck {
  const opportunities: Opportunity[] = [];
  let duplicates = 0;
  let offAngle = 0;
  let ungrounded = 0;
  let unanchored = 0;

  for (const candidate of candidates) {
    // A model that found nothing sometimes answers with a placeholder idea
    // ("(无有效灵感)", "不适用"); shipping that as a card would be a fake result.
    if (/无有效|没有有效|不适用|无相关灵感/.test(`${candidate.title}${candidate.problem}`)) continue;

    // The angle must resolve to one this round planned: an idea tagged with an
    // angle nobody chose is either a leftover from the prompt or a
    // hallucination. Models shorten the planner's label, so resolution allows
    // containment, but the stored angle is always the planned one.
    const angle =
      context.allowedAngles.size === 0
        ? candidate.angle.trim()
        : resolvePlannedAngle(candidate.angle, context.angles);
    if (angle === null) {
      offAngle += 1;
      continue;
    }

    // The model may copy a URL it was not given; such a citation cannot be
    // verified, so the whole candidate is dropped rather than shipped.
    const seenUrls = new Set<string>();
    const evidence = candidate.evidence.filter((item) => {
      const source = context.allowed.get(item.url);
      if (source === undefined || seenUrls.has(item.url)) return false;
      // The quote must exist in the source: URL-only citations let a model
      // attach a fabricated sentence to a real page.
      if (!quoteGrounded(item.quote, `${source.title}\n${source.snippet}`)) return false;
      seenUrls.add(item.url);
      return true;
    });
    if (evidence.length === 0) {
      ungrounded += 1;
      continue;
    }

    // Commercial anchoring: at least one cited page must talk about money,
    // hiring or a paid alternative. Without it the idea is just a complaint.
    const anchored = evidence.some((item) => {
      const source = context.allowed.get(item.url);
      return source !== undefined && hasBusinessSignal(`${source.title}\n${source.snippet}`);
    });
    if (!anchored) {
      unanchored += 1;
      continue;
    }

    // Cross-scan novelty: a direction already produced in a recent round is
    // dropped even when the wording changes, so the radar does not hand back
    // the same idea with a new title.
    if (!isNovelFingerprint(opportunityFingerprint(candidate.title, candidate.problem), context.prior)) {
      duplicates += 1;
      continue;
    }

    opportunities.push({ ...candidate, angle, evidence });
  }

  return { opportunities, duplicates, offAngle, ungrounded, unanchored };
}

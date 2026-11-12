import type { LlmPort } from '@/lib/llm/port';
import type { SearchPort } from '@/lib/search/port';

import { resolvePlannedAngle } from './angles';
import { parseJsonObject } from './json';
import { scanLog } from './log';
import {
  ideaTokens,
  isNovelFingerprint,
  isRepeatedIdea,
  opportunityFingerprint,
} from './novelty';
import { DISCOVERY_HITS_PER_QUERY, pickDiscoveryQueries } from './queries';
import {
  hasBusinessSignal,
  hasDemandLanguage,
  isFirstHandSource,
  quoteGrounded,
  selectSources,
  sourceText,
} from './sources';
import {
  discoverySchema,
  type DiscoveryPlan,
  type DiscoverySource,
  type Opportunity,
} from './types';

/** Enough context for the model without turning the prompt into a crawl. */
export const MAX_SOURCES = 12;

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
export const DISCOVERY_LLM_TIMEOUT_MS = 260_000;

/** One angle's completion; sequential so the provider answers one at a time. */
const PER_ANGLE_TIMEOUT_MS = 120_000;

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
  /** Titles/problems of recent opportunities, so the model can avoid repeats. */
  priorIdeas?: readonly { title: string; problem: string }[] | undefined;
  /** Streaming progress: search → filter → model. */
  onPhase?: (phase: 'search' | 'filter' | 'model', detail?: number) => void;
};

/** The scan's own findings; the route adds memory and novelty metadata. */
export interface DiscoveryValue {
  sources: DiscoverySource[];
  opportunities: Opportunity[];
  /** True when the returned ideas had to be shipped without a paid signal. */
  commercialGap: boolean;
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
      /** What was already collected, so a model outage still shows the search. */
      partial?: { sources: DiscoverySource[]; providers: string[] };
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
  const priorIdeas = deps.priorIdeas ?? [];

  // Queries run together: discovery is interactive, and the adapters' shared
  // limiter already serialises calls per host, so this does not burst.
  const portCalls = new Map<string, number>();
  const portSeen = new Map<string, number>();
  const perQuery = await Promise.all(
    queries.map(async (query) => {
      const answered: {
        provider: string;
        hits: { url: string; title: string; snippet: string; platform: string }[];
      }[] = [];

      for (const port of deps.searchPorts) {
        // Slow platforms serve a bounded number of queries per scan; queries a
        // port cannot answer do not spend its budget.
        if (port.supportsQuery !== undefined && !port.supportsQuery(query)) continue;
        const seen = portSeen.get(port.id) ?? 0;
        portSeen.set(port.id, seen + 1);
        if (port.queryOffset !== undefined && seen < port.queryOffset) continue;
        const used = portCalls.get(port.id) ?? 0;
        if (port.maxQueries !== undefined && used >= port.maxQueries) continue;
        portCalls.set(port.id, used + 1);
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

  async function askOnce(
    prompt: { system: string; user: string },
    signal: AbortSignal,
    timeoutMs: number,
    maxItems?: number,
  ) {
    try {
      // Text rather than `structured`: several OpenAI-compatible providers
      // hang or ignore `response_format` here, while the prompt already spells
      // out the exact JSON object. Parse and validate locally instead.
      const result = await deps.llm.text(prompt, {
        profile: 'bulk',
        timeoutMs,
        signal,
        ...(maxItems === undefined ? {} : { maxItems }),
      });
      if (!result.ok) return result;
      const parsed = parseJsonObject(result.value.text);
      const decoded = parsed === null ? null : discoverySchema.safeParse(parsed);
      if (decoded === null || !decoded.success) {
        return { ok: false as const, code: 'bad_output', message: '模型输出不是合法 JSON' };
      }
      return {
        ok: true as const,
        value: {
          data: decoded.data,
          used: result.value.used,
          usage: result.value.usage,
        },
      };
    } catch {
      return null;
    }
  }

  // One request for 3–5 ideas forces a slow model to reason about diversity
  // and four sets of evidence at once; per-angle requests are smaller and a
  // single timeout no longer discards the whole round.
  async function askAngles(
    anglesToAsk: readonly string[],
  ): Promise<{ ideas: Opportunity[]; model: string } | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DISCOVERY_LLM_TIMEOUT_MS);
    const queue = [...anglesToAsk.slice(0, 2)];
    const ideas: Opportunity[] = [];
    const models = new Set<string>();
    let succeeded = false;

    async function worker(): Promise<void> {
      for (;;) {
        const angle = queue.shift();
        if (angle === undefined || controller.signal.aborted) return;
        const result = await askOnce(
          buildPrompt(sources, [angle], priorIdeas, undefined, angle),
          controller.signal,
          PER_ANGLE_TIMEOUT_MS,
          // One model per angle: chaining to the second model doubles the wait
          // and the provider may be usage-limited anyway.
          1,
        );
        if (result !== null && result.ok) {
          succeeded = true;
          models.add(result.value.used.modelId);
          ideas.push(...result.value.data.opportunities);
        }
      }
    }

    try {
      // Sequential: concurrent long completions on one provider key are
      // throttled and each passes the per-call deadline.
      const workers = 1;
      await Promise.all(Array.from({ length: workers }, () => worker()));
    } finally {
      clearTimeout(timer);
    }
    return succeeded ? { ideas, model: [...models].join('+') } : null;
  }

  async function askModel(prompt: { system: string; user: string }) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DISCOVERY_LLM_TIMEOUT_MS);
    const timedOut = new Promise<null>((resolve) => {
      controller.signal.addEventListener('abort', () => resolve(null), { once: true });
    });
    try {
      return await Promise.race([
        askOnce(prompt, controller.signal, DISCOVERY_LLM_TIMEOUT_MS - 5_000),
        timedOut,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  const allowed = new Map(sources.map((source) => [source.url, source]));
  const check = (candidates: readonly Opportunity[]) =>
    validateCandidates(candidates, {
      allowed,
      angles,
      allowedAngles,
      prior,
      priorTokens: priorIdeas.map((idea) => ideaTokens(idea.title, idea.problem)),
      firstHandAvailable: sources.some((source) => isFirstHandSource(source.url)),
      demandAvailable: sources.some((source) => hasDemandLanguage(sourceText(source))),
    });

  const partial = { sources, providers: [...providers] };
  let modelLabel: string;
  let rawIdeas: Opportunity[];

  if (angles.length >= 2) {
    const run = await askAngles(angles);
    if (run === null) {
      return {
        ok: false,
        code: 'LLM_UNAVAILABLE',
        message: '模型响应超时，请重试（本次扫描未完成）。',
        partial,
      };
    }
    modelLabel = run.model;
    rawIdeas = run.ideas;
  } else {
    const asked = await askModel(buildPrompt(sources, angles, priorIdeas));
    if (asked === null) {
      return {
        ok: false,
        code: 'LLM_UNAVAILABLE',
        message: '模型响应超时，请重试（本次扫描未完成）。',
        partial,
      };
    }
    if (!asked.ok) {
      return {
        ok: false,
        code: 'LLM_UNAVAILABLE',
        message: `灵感分析失败：${asked.message}${failureHint(asked.message)}`,
        partial,
      };
    }
    modelLabel = asked.value.used.modelId;
    rawIdeas = asked.value.data.opportunities;
  }

  let checked = check(rawIdeas);
  scanLog(
    `model=${modelLabel} returned=${rawIdeas.length} ` +
      `accepted=${checked.opportunities.length} ungrounded=${checked.ungrounded} ` +
      `unanchored=${checked.unanchored} noFirstHand=${checked.noFirstHand} ` +
      `noDemand=${checked.noDemand} offAngle=${checked.offAngle} duplicates=${checked.duplicates} ` +
      `angles=[${angles.join('|')}] demandSources=${sources.filter((source) => hasDemandLanguage(sourceText(source))).length}`,
  );

  // A model that ignored the evidence rules gets one corrective retry on the
  // same snippets: replanning costs a search round and may not fix the cause.
  if (
    checked.opportunities.length === 0 &&
    (checked.ungrounded > 0 || checked.unanchored > 0 || checked.noDemand > 0)
  ) {
    const problems = [
      checked.ungrounded > 0 ? `${checked.ungrounded} 条灵感的 quote 在片段里找不到原文` : '',
      checked.unanchored > 0 ? `${checked.unanchored} 条灵感没有引用带「商业线索」标记的片段` : '',
      checked.noFirstHand > 0 ? `${checked.noFirstHand} 条灵感没有引用带「真实讨论」标记的片段` : '',
      checked.noDemand > 0 ? `${checked.noDemand} 条灵感没有引用带「需求原话」标记的片段` : '',
      checked.placeholder > 0 ? `${checked.placeholder} 条输出是「无有效灵感」占位内容` : '',
    ]
      .filter((problem) => problem !== '')
      .join('；');

    const retry = await askModel(
      buildPrompt(
        sources,
        angles,
        priorIdeas,
        `${problems}。这一轮 quote 必须逐字来自片段，并且每条灵感至少引用一条带「商业线索」标记的片段；做不到就不要输出该条。`,
      ),
    );
    if (retry !== null && retry.ok) {
      const second = check(retry.value.data.opportunities);
      if (second.opportunities.length > 0) {
        modelLabel = retry.value.used.modelId;
        checked = second;
      }
    }
  }

  const { duplicates, offAngle, ungrounded, unanchored, noDemand, placeholder } = checked;
  // Evidence beats silence: a grounded, on-angle idea without a paid source is
  // still a lead. It ships flagged rather than failing the whole scan, and the
  // UI tells the operator what is missing.
  let opportunities = checked.opportunities;
  let commercialGap = false;
  if (opportunities.length === 0 && checked.unanchoredItems.length > 0) {
    opportunities = checked.unanchoredItems;
    commercialGap = true;
  }

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
      message: `模型输出未通过校验：引文不匹配 ${ungrounded}、缺少商业线索 ${unanchored}、缺少需求原话 ${noDemand}、角度不符 ${offAngle}、占位/无有效灵感 ${placeholder}，本次扫描作废。`,
    };
  }

  return {
    ok: true,
    value: {
      sources,
      opportunities,
      commercialGap,
      providers: [...providers],
      elapsedMs: Date.now() - startedAt,
      model: modelLabel,
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
  priorIdeas: readonly { title: string; problem: string }[],
  hint?: string,
  focus?: string,
): { system: string; user: string } {
  const ordered = [...sources].sort((left, right) => {
    const leftBusiness = hasBusinessSignal(`${left.title}\n${left.snippet}`) ? 1 : 0;
    const rightBusiness = hasBusinessSignal(`${right.title}\n${right.snippet}`) ? 1 : 0;
    return rightBusiness - leftBusiness;
  });

  const businessIndexes = ordered.flatMap((source, index) =>
    hasBusinessSignal(`${source.title}\n${source.snippet}`) ? [index + 1] : [],
  );
  const demandIndexes = ordered.flatMap((source, index) =>
    hasDemandLanguage(`${source.title}\n${source.snippet}`) ? [index + 1] : [],
  );

  const list = ordered
    .map((source, index) => {
      const marks = [
        businessIndexes.includes(index + 1) ? '[商业线索]' : '',
        isFirstHandSource(source.url) ? '[真实讨论]' : '',
        demandIndexes.includes(index + 1) ? '[需求原话]' : '',
      ]
        .filter((mark) => mark !== '')
        .join('');
      return `[${index + 1}] ${marks === '' ? '' : `${marks} `}${source.title}\nURL: ${source.url}\n片段: ${source.snippet.slice(0, 300)}`;
    })
    .join('\n\n');

  const requiredSources =
    businessIndexes.length === 0
      ? '（本轮没有含商业线索的片段）'
      : businessIndexes.map((index) => `[${index}]`).join(' ');

  const firstHandAvailable = ordered.some((source) => isFirstHandSource(source.url));
  const demandRule =
    demandIndexes.length === 0
      ? '- 本轮没有带「需求原话」标记的片段：quote 必须是最接近用户抱怨的原话，不要用厂商文案或第三人称总结。'
      : '- 每条灵感的 evidence 至少一条 quote 来自带「需求原话」标记的片段（用户自己说「我需要/我想要/求推荐/愿意付费」）。没有可引用的需求原话就不要输出这条灵感。';

  const firstHandRule = firstHandAvailable
    ? '- 每条灵感至少一条引文来自带「真实讨论」标记的片段（Reddit / Hacker News / GitHub Issue / 论坛里用户自述）；没有真实讨论就不要输出这条灵感。'
    : '- 本轮没有带「真实讨论」标记的片段：可以引用普通网页，但 problem 必须写明这是二手描述，不要把厂商宣传语当用户原话。';

  const recentIdeas =
    priorIdeas.length === 0
      ? '（没有历史灵感）'
      : priorIdeas
          .slice(0, 12)
          .map(
            (idea, index) =>
              `${index + 1}. ${idea.title}｜${idea.problem.slice(0, 70)}`,
          )
          .join('\n');

  const angleRule =
    focus !== undefined
      ? `本轮只针对「${focus}」这个角度，angle 必须原样写成「${focus}」。`
      : angles.length === 0
        ? '每条灵感都要带 angle，用一个能说明买家与工作流的短标签。'
        : `本轮的 angle 只能从以下列表里取，且尽量让不同灵感落在不同角度上：\n${angles
            .map((angle) => `- ${angle}`)
            .join('\n')}`;
  const ideaCount = focus === undefined ? '3–5' : '1–2';
  const perAngleRule =
    focus === undefined
      ? '${perAngleRule}'
      : '- 只输出这个角度下的 1–2 条灵感，每条仍要满足所有证据要求。';

  return {
    system: `你是独立开发者的灵感侦察员。只根据给定片段判断，不得补充搜索。
严格输出这个 JSON 结构，不要 markdown 代码块，不要解释：
{"opportunities":[{"title":"","problem":"","audience":"","angle":"","signal":"problem","currentAlternative":"","competitors":[],"monetization":"subscription","mvp":"","evidence":[{"url":"","quote":""}]}]}
输出 ${ideaCount} 个值得验证的产品灵感，尽量覆盖不同领域（中英文来源都要用到），不要反复描述同一个问题来凑数；每条都必须引用片段里的 URL，并给出原文短句作为 quote。
要求：
- problem 写用户的原话困境，不是功能清单。
- ${angleRule}
- signal 只能是 problem / seeking / paying / switching / recurring。
- currentAlternative 写用户现在怎么解决；competitors 只写片段里点名的产品或服务，没有就空数组。
- monetization 只能是 subscription / usage / one-time / service。
- mvp 写一个人 1–2 周能上线的范围；需要牌照、硬件、双边市场或大规模数据的想法不要输出。
- 每条灵感的 evidence 至少引用一条下方「必选证据来源」里的编号；这些片段含价格、付费、招聘、外包或替代方案。没有商业线索可引用就不要输出这条灵感。
${firstHandRule}
${demandRule}
- 片段之间互相矛盾或只是同一来源的重复，不要当成多个灵感。
- 不要重复「最近已产出的灵感」里的方向；如果确实要深挖，必须换买家或工作流，并在 title/problem 里体现差异。
${perAngleRule}
- 全部用中文。${hint === undefined ? '' : `\n\n上一轮的问题：${hint}`}`,
    user: `必选证据来源（含商业线索）：${requiredSources}\n\n最近已产出的灵感（不要重复）：\n${recentIdeas}\n\n候选片段：\n\n${list}\n\n请输出 opportunities 数组。`,
  };
}

type CandidateCheck = {
  /** Ideas dropped because they wrote to demand but cited no demand-language source. */
  noDemand: number;
  opportunities: Opportunity[];
  /** Grounded, on-angle, novel ideas with no commercial citation. */
  unanchoredItems: Opportunity[];
  duplicates: number;
  offAngle: number;
  ungrounded: number;
  unanchored: number;
  /** Ideas with no first-hand (community/issue) citation; used for correction. */
  noFirstHand: number;
  /** "（无有效灵感）" placeholders a model emits when it found nothing. */
  placeholder: number;
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
    priorTokens: readonly ReadonlySet<string>[];
    firstHandAvailable: boolean;
    demandAvailable: boolean;
  },
): CandidateCheck {
  const opportunities: Opportunity[] = [];
  const unanchoredItems: Opportunity[] = [];
  const acceptedTokens: ReadonlySet<string>[] = [];
  const usedAngles = new Set<string>();
  let duplicates = 0;
  let offAngle = 0;
  let ungrounded = 0;
  let unanchored = 0;
  let noFirstHand = 0;
  let noDemand = 0;
  let placeholder = 0;

  for (const candidate of candidates) {
    // A model that found nothing sometimes answers with a placeholder idea
    // ("(无有效灵感)", "不适用"); shipping that as a card would be a fake result.
    if (/无有效|没有有效|不适用|无相关灵感/.test(`${candidate.title}${candidate.problem}`)) {
      placeholder += 1;
      continue;
    }

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

    // Cross-scan novelty: a direction already produced in a recent round is
    // dropped even when the wording changes, so the radar does not hand back
    // the same idea with a new title.
    if (!isNovelFingerprint(opportunityFingerprint(candidate.title, candidate.problem), context.prior)) {
      duplicates += 1;
      continue;
    }

    // Two ideas built on the same workflow words are one lead. Compare with
    // previous rounds and with what this round already accepted.
    const tokens = ideaTokens(candidate.title, candidate.problem);
    if (isRepeatedIdea(tokens, context.priorTokens) || isRepeatedIdea(tokens, acceptedTokens)) {
      duplicates += 1;
      continue;
    }

    // Commercial anchoring: at least one cited page must talk about money,
    // hiring or a paid alternative. Without it the idea is a complaint, not a
    // market signal; it is kept aside only as a flagged fallback.
    // When the scan did find community/issue threads, an idea that cites only
    // vendor copy is not demand; drop it rather than ship marketing as a lead.
    if (context.firstHandAvailable && !evidence.some((item) => isFirstHandSource(item.url))) {
      noFirstHand += 1;
      continue;
    }

    // Demand evidence must be the user's own words ("I need", "求推荐", "愿意
    // 付费"), not a vendor page or a third-person summary. Only enforced when
    // the round actually collected such a snippet.
    if (
      context.demandAvailable &&
      !evidence.some((item) => {
        const source = context.allowed.get(item.url);
        return source !== undefined && hasDemandLanguage(sourceText(source));
      })
    ) {
      noDemand += 1;
      continue;
    }

    const anchored = evidence.some((item) => {
      const source = context.allowed.get(item.url);
      return source !== undefined && hasBusinessSignal(`${source.title}\n${source.snippet}`);
    });
    if (usedAngles.has(angle)) {
      duplicates += 1;
      continue;
    }
    usedAngles.add(angle);
    acceptedTokens.push(tokens);

    if (!anchored) {
      unanchored += 1;
      unanchoredItems.push({ ...candidate, angle, evidence });
      continue;
    }

    opportunities.push({ ...candidate, angle, evidence });
  }

  return {
    opportunities,
    unanchoredItems,
    duplicates,
    offAngle,
    ungrounded,
    unanchored,
    noFirstHand,
    noDemand,
    placeholder,
  };
}

import type { LlmPort } from '@/lib/llm/port';

import { resolvePlannedAngle } from './angles';
import { coveredDomains, domainOf, domainLabel } from './domains';
import { DISCOVERY_QUERIES_PER_SCAN, pickDiscoveryQueries } from './queries';
import {
  discoveryPlanSchema,
  type DiscoveryPlan,
  type ScanMemory,
  type TrendItem,
} from './types';

/** Angle used when the model cannot plan; keeps every result angle-tagged. */
export const FALLBACK_ANGLE = '通用业务手工痛点';

/** The planner must not hang the interactive scan; fallback is cheap. */
export const PLAN_TIMEOUT_MS = 30_000;

/**
 * Forced exploration seeds. The planner is told to look through two random
 * industries it has not covered, which is what breaks the "same six SaaS
 * themes" attractor a pure trend prompt falls into.
 */
export const EXPLORATION_SEEDS: readonly string[] = [
  '法律与合规',
  '餐饮与门店',
  '建筑与装修',
  '教育与培训',
  '诊所与健康',
  '物流与货代',
  '电商运营',
  '宠物服务',
  '健身与运动',
  '房产中介',
  '制造业工厂',
  '农业与合作社',
  '活动与会展',
  '非营利组织',
  '保险与理赔',
  '本地生活服务',
];

export interface PlanPorts {
  llm: Pick<LlmPort, 'structured'>;
  memory: ScanMemory;
  trends: readonly TrendItem[];
  /** False when the trend request failed, so the prompt says so instead of lying. */
  trendsAvailable: boolean;
  random?: () => number;
  now?: () => Date;
  /** Operator-chosen angles; when present the planner may not invent others. */
  directions?: readonly string[];
}

export interface PlanPrompt {
  system: string;
  user: string;
  seeds: string[];
}

/** Trim, dedupe and cap what the operator typed; the UI enforces the same. */
export function cleanDirections(directions: readonly string[] = []): string[] {
  const clean: string[] = [];
  for (const direction of directions) {
    const value = direction.trim().replace(/\s+/g, ' ');
    if (value === '' || value.length > 40 || clean.includes(value)) continue;
    clean.push(value);
    if (clean.length === 5) break;
  }
  return clean;
}

function pickSeeds(random: () => number): string[] {
  const pool = [...EXPLORATION_SEEDS];
  const seeds: string[] = [];
  while (seeds.length < 2 && pool.length > 0) {
    const index = Math.min(pool.length - 1, Math.floor(random() * pool.length));
    const seed = pool.splice(index, 1)[0] ?? '';
    if (seed === '') continue;
    // Two seeds in the same buyer domain produce variations of one angle;
    // require the second seed to open a different market.
    const seedDomain = domainOf(seed);
    if (seeds.some((chosen) => domainOf(chosen) === seedDomain)) continue;
    seeds.push(seed);
  }
  return seeds;
}

function trendBlock(trends: readonly TrendItem[], available: boolean): string {
  if (!available) return '热点源本轮不可达；只依据历史与探索种子规划。';
  if (trends.length === 0) return '近 14 天没有达到热度阈值的故事；靠历史与探索种子规划。';

  return trends
    .slice(0, 14)
    .map((trend) => {
      const points = trend.points === null ? '' : `（${trend.points} 分）`;
      const snippet = trend.snippet === '' ? '' : `｜${trend.snippet.slice(0, 120)}`;
      return `- ${trend.title}${points}${snippet}`;
    })
    .join('\n');
}

function historyBlock(memory: ScanMemory): string {
  if (memory.scans.length === 0) return '（没有历史扫描）';

  return memory.scans
    .slice(0, 10)
    .map((scan, index) => {
      const angles = scan.angles.join(' / ') || '（无角度记录）';
      const titles = scan.opportunities
        .slice(0, 4)
        .map((item) => item.title)
        .join('；');
      const queries = scan.queries.slice(0, 6).join('；');
      return `${index + 1}. 角度：${angles}\n   已产出：${titles || '—'}\n   查询：${queries || '—'}`;
    })
    .join('\n');
}

export function buildPlanPrompt(
  memory: ScanMemory,
  trends: readonly TrendItem[],
  trendsAvailable: boolean,
  seeds: readonly string[],
  directions: readonly string[] = [],
  avoidDomains: readonly string[] = [],
  hint?: string,
): PlanPrompt {
  const directed = directions.length > 0;
  const avoid = avoidDomains.map(domainLabel).join('、');
  const adopted =
    memory.adopted.length === 0
      ? '（还没有被采用的灵感）'
      : memory.adopted
          .slice(0, 8)
          .map((item) => `- ${item.title}${item.angle === null ? '' : `（${item.angle}）`}`)
          .join('\n');

  const fixedRule = directed
    ? `- 本轮用户指定了方向：${directions.join('、')}。angles 必须逐字等于这个列表，不得增删或改名。
- 每个指定方向输出 2–4 条查询，共 4–12 条；中英文都要有；仍然是行业词 + 痛点词 + 商业语境的组合。
- 不要引入列表之外的角度；历史扫描里的角度只用于避免重复写法。`
    : `- 输出 3–6 个互不重叠的角度，且必须来自不同的买家领域（财务、人力、客服、电商、物流、建筑、制造、医疗、教育、餐饮、法律、销售、健身、房产、宠物、会展、农业、保险、软件运维、设计）；同一领域只能出现一个角度，禁止用同一产品形态换行业凑数。
- 每个角度必须能对应一个具体买家（谁）与具体工作流（做什么），不要写"AI 工具""效率提升"这类空泛主题。${avoid === '' ? '' : `\n- 最近扫描已覆盖这些领域，本轮不要再选：${avoid}。`}`;

  return {
    system: `你是产品机会雷达的侦察规划员。任务不是复述热点，而是为一个独立开发者规划本轮要验证的角度和搜索查询。
规则：
${fixedRule}
- 角度名必须是 2–10 个字的短标签（如「诊所排班」「外贸单据」），不要写成解释句、不要带冒号；具体买家与工作流放进查询词里。
- 历史扫描出现过的角度不要重复；如果某个角度已被采用（用户真的开始研究），可以换一个更窄的子方向继续深挖，但要在角度名里体现差异。
- 查询要像真实用户会打出的关键词，包含行业词 + 痛点词，不要用站点限定符，不要堆砌同义词。
- 自动规划时输出 8–12 条查询，每个角度至少 1 条；中英文都要有。
- 查询必须能带出商业语境：优先"愿意付费/报价/采购/招聘/外包/替代方案/太贵"这类词，避免只检索教程、百科或纯情绪讨论；每个角度都要能回答"谁现在为此花钱或花时间"。
- 优先从本轮热点里寻找"人们最近正在抱怨/求工具"的工作流，但不要原样抄标题；热点只用来启发角度。
${directed ? '- 探索种子本轮不适用，方向已由用户指定。' : '- 把探索种子当作本轮必须认真看的方向，可以产出 1–2 个与种子相关的角度。'}
- rationale 用一句中文说明本轮为什么选这些角度（≤60 字）。${hint === undefined ? '' : `\n\n上一轮的问题：${hint}`}`,
    user: `最近热点（Hacker News，近 14 天，按热度）：
${trendBlock(trends, trendsAvailable)}

历史扫描（新→旧）：
${historyBlock(memory)}

已被采用的方向：
${adopted}

本轮探索种子：${directed ? '（用户已指定方向，忽略种子）' : seeds.join('、')}

请输出 JSON：{ angles: string[], queries: [{ query, angle, language }], rationale }`,
    seeds: [...seeds],
  };
}

/**
 * Asks the model for this round's angles and queries, then validates its
 * answer. Anything the scan cannot trust — an unplanned angle, duplicated
 * queries, too few new angles — falls back to the static pool instead of
 * shipping a half-planned round.
 */
export async function planScan(ports: PlanPorts): Promise<DiscoveryPlan> {
  const random = ports.random ?? Math.random;
  const directions = cleanDirections(ports.directions);
  const seeds = directions.length > 0 ? [] : pickSeeds(random);
  // Only the last three scans hard-exclude a domain: the whole 12-scan memory
  // would eventually cover the taxonomy and force a generic fallback.
  const avoidDomains =
    directions.length === 0
      ? coveredDomains(ports.memory.scans.slice(0, 3).flatMap((scan) => scan.angles))
      : [];
  let hint: string | undefined;

  // Two attempts: a small model often puts six angles in one domain on the
  // first try; the corrective prompt names the problem instead of falling
  // straight back to the generic pool.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const prompt = buildPlanPrompt(
      ports.memory,
      ports.trends,
      ports.trendsAvailable,
      seeds,
      directions,
      avoidDomains,
      hint,
    );

    const asked = await ports.llm
      .structured(discoveryPlanSchema, { system: prompt.system, user: prompt.user }, {
        profile: 'bulk',
        fallbackProfile: 'quality',
        timeoutMs: PLAN_TIMEOUT_MS,
      })
      .catch(() => null);

    if (asked !== null && asked.ok) {
      const plan = normalizePlan(
        asked.value.data,
        asked.value.used.modelId,
        directions,
        avoidDomains,
      );
      if (plan !== null) return plan;
    }

    hint = '上一轮的角度在同一买家领域内重复，或覆盖了最近扫描已用过的领域。请让每个角度来自不同领域，并避开已覆盖领域。';
  }

  return fallbackPlan(random, directions);
}

/** Dedupe + angle validation; `null` means "not usable, fall back". */
export function normalizePlan(
  raw: { angles: string[]; queries: { query: string; angle: string; language: 'zh' | 'en' }[]; rationale: string },
  model?: string,
  directions: readonly string[] = [],
  avoidDomains: readonly string[] = [],
): DiscoveryPlan | null {
  const directed = directions.length > 0;
  const angles = directed ? [...directions] : [];
  if (!directed) {
    const declared: string[] = [];
    for (const angle of raw.angles) {
      const clean = angle.trim();
      if (clean === '' || declared.includes(clean)) continue;
      declared.push(clean);
    }
    // Keep the model's plan but trim it to distinct markets: at most two
    // sub-angles per buyer domain, none from a recently covered domain. This
    // is how six construction variants become a spread-out plan instead of an
    // all-or-nothing rejection.
    for (const angle of declared) {
      const domain = domainOf(angle) ?? `angle:${angle}`;
      if (avoidDomains.includes(domain)) continue;
      const used = angles.filter((kept) => (domainOf(kept) ?? `angle:${kept}`) === domain).length;
      if (used >= 2) continue;
      angles.push(angle);
    }
    if (angles.length < 3) return null;
    const distinct = new Set(angles.map((angle) => domainOf(angle) ?? `angle:${angle}`)).size;
    if (distinct < 2) return null;
  }

  const seen = new Set<string>();
  const queries = raw.queries.flatMap((item) => {
    const query = item.query.trim().replace(/\s+/g, ' ');
    // Directed scans still let the model paraphrase the angle; bind it back to
    // the operator's exact label so the deck and memory stay consistent.
    const angle = directed
      ? resolvePlannedAngle(item.angle, angles)
      : angles.includes(item.angle.trim())
        ? item.angle.trim()
        : null;
    if (query === '' || angle === null) return [];
    const key = query.toLowerCase();
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ query, angle, language: item.language }];
  });

  const covered = new Set(queries.map((item) => item.angle));
  if (directed) {
    if (!angles.every((angle) => covered.has(angle))) return null;
    if (queries.length < Math.min(8, angles.length * 2)) return null;
  } else {
    // Trimming may drop some of the model's queries; the kept angles must all
    // still be represented, and the plan must stay broad enough to be useful.
    if (!angles.every((angle) => covered.has(angle))) return null;
    if (queries.length < Math.min(8, angles.length * 2)) return null;
  }

  return {
    angles,
    queries,
    strategy: directed ? 'directed' : 'planned',
    rationale:
      raw.rationale.trim() ||
      (directed ? '按你指定方向生成查询。' : '按最近热点与历史扫描重新规划了角度。'),
    ...(model === undefined ? {} : { model }),
  };
}

/**
 * The static pool, still random per scan. It keeps the radar working when no
 * model is configured, and the UI reports `strategy: fallback` so the operator
 * knows the angles were not model-chosen.
 */
export function fallbackPlan(
  random: () => number = Math.random,
  directions: readonly string[] = [],
): DiscoveryPlan {
  const directed = cleanDirections(directions);

  if (directed.length > 0) {
    // Mechanical but on-topic: a directed scan must never silently fall back
    // to the generic pool, because that would ignore the operator's choice.
    const queries = directed
      .flatMap((angle) => [
        `${angle} 手工 excel 太麻烦 工具`,
        `${angle} 愿意付费 替代方案`,
        `${angle} 外包 报价 招聘`,
      ])
      .slice(0, 12)
      .map((query) => ({
        query,
        angle:
          directed.find((angle) => query.startsWith(angle)) ?? directed[0] ?? FALLBACK_ANGLE,
        language: /[\u4e00-\u9fff]/.test(query) ? ('zh' as const) : ('en' as const),
      }));

    return {
      angles: directed,
      queries,
      strategy: 'directed',
      rationale: '按你指定方向生成模板查询（模型不可用或输出不合规）。',
    };
  }

  const queries = pickDiscoveryQueries(DISCOVERY_QUERIES_PER_SCAN, random);
  return {
    angles: [FALLBACK_ANGLE],
    queries: queries.map((query) => ({
      query,
      angle: FALLBACK_ANGLE,
      language: /[\u4e00-\u9fff]/.test(query) ? 'zh' : 'en',
    })),
    strategy: 'fallback',
    rationale: '本轮未能生成新角度（模型不可用或输出不合规），回退固定查询池。',
  };
}

import { z } from 'zod';

import type { LlmPort } from '@/lib/llm/port';

import type { AngleGroup, AngleKind } from './angles';

/** The six template classes; the planner may omit a class but not invent one. */
const ANGLE_KINDS = [
  'problem',
  'seeking',
  'paying',
  'switching',
  'frequency',
  'competitor',
] as const;

const queryPlanSchema = z.object({
  groups: z
    .array(
      z.object({
        angle: z.enum(ANGLE_KINDS),
        queries: z.array(z.string().trim().min(2).max(80)).min(1).max(3),
      }),
    )
    .min(3)
    .max(6),
});

/** A slow planner must not delay S1; the template fallback is deterministic. */
export const QUERY_PLAN_TIMEOUT_MS = 20_000;

export interface QueryPlanPrompt {
  system: string;
  user: string;
}

export function buildQueryPlanPrompt(idea: string, hint?: string): QueryPlanPrompt {
  return {
    system: `你是市场研究的检索规划员。把用户的想法变成短搜索查询：
- 每个信号角度给 1–3 条查询；总共 8–14 条。
- 查询 2–6 个词，像真实用户会搜索的关键词；不要粘贴整段想法，不要用 site: 操作符，不要堆砌同义词。
- 中英文都要有，英文至少 4 条；英文查询用于 Hacker News、Reddit、GitHub Issues 等英文社区。
- 使用想法里的具体名词（工具名、支付渠道、职位、行业）；拿不准的英文术语照常见写法。
- problem=抱怨/太麻烦；seeking=求推荐；paying=价格/付费；switching=替代/迁移；frequency=使用频率；competitor=竞品/定价对比。${hint === undefined ? '' : `\n\n上一轮的问题：${hint}`}`,
    user: `想法：${idea}\n\n请输出 JSON：{ groups: [{ angle, queries: string[] }] }`,
  };
}

/** Dedupe + require real breadth; `null` means "use the template fallback". */
export function normalizeQueryPlan(
  groups: readonly AngleGroup[],
  minEnglish = 4,
): AngleGroup[] | null {
  const seenAngles = new Set<AngleKind>();
  const seenQueries = new Set<string>();
  const normalized: AngleGroup[] = [];

  for (const group of groups) {
    if (seenAngles.has(group.angle)) continue;
    const queries: string[] = [];
    for (const query of group.queries) {
      const clean = query.trim().replace(/\s+/g, ' ');
      const key = clean.toLowerCase();
      if (clean === '' || seenQueries.has(key)) continue;
      seenQueries.add(key);
      queries.push(clean);
      if (queries.length === 3) break;
    }
    if (queries.length === 0) continue;
    seenAngles.add(group.angle);
    normalized.push({ angle: group.angle, queries });
  }

  if (normalized.length < 3) return null;
  const queries = normalized.flatMap((group) => group.queries);
  if (queries.length < 8) return null;
  // English queries are what reach HN / Reddit / GitHub; a plan without them
  // silently collapses back to Chinese web results.
  if (queries.filter((query) => !/[\u4e00-\u9fff]/.test(query)).length < minEnglish) return null;
  return normalized;
}

/**
 * Asks the bulk chain for search queries, including English ones that the
 * Chinese-only templates cannot produce. Any failure returns `null`, and S1
 * falls back to `buildAngles` exactly as before.
 */
export async function planSearchQueries(
  idea: string,
  llm: Pick<LlmPort, 'structured'>,
): Promise<AngleGroup[] | null> {
  let hint: string | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const prompt = buildQueryPlanPrompt(idea, hint);
    const asked = await llm
      .structured(queryPlanSchema, prompt, { profile: 'bulk', timeoutMs: QUERY_PLAN_TIMEOUT_MS })
      .catch(() => null);

    if (asked !== null && asked.ok) {
      const plan = normalizeQueryPlan(asked.value.data.groups);
      if (plan !== null) return plan;
    }
    hint = '英文查询少于 4 条，或查询/角度数量不足。请把关键术语翻成英文，保持 8–14 条、中英各半。';
  }
  return null;
}

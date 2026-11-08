/**
 * S0 without an LLM: the five signal classes of the spec, each expressed as
 * Chinese search queries built from the user's own words. Templates are
 * deterministic on purpose — the same idea always yields the same queries, so
 * a re-run is idempotent and a test can pin them.
 */

/** The five signals, graded separately and never merged. */
export type AngleKind = 'problem' | 'seeking' | 'paying' | 'switching' | 'frequency' | 'competitor';

export interface AngleGroup {
  angle: AngleKind;
  /** 2–3 queries, unique within the group and across the whole result. */
  queries: string[];
}

/**
 * Suffixes are written the way a Chinese user actually searches: complain,
 * ask for a recommendation, quote a price, look for a replacement, mention how
 * often the task comes up. `${idea}` is prefixed verbatim.
 */
const TEMPLATES: ReadonlyArray<{ angle: AngleKind; suffixes: readonly string[] }> = [
  { angle: 'problem', suffixes: ['太麻烦', '手动操作 效率低', '痛点 吐槽'] },
  { angle: 'seeking', suffixes: ['有没有 推荐', '怎么解决', '求推荐 工具'] },
  { angle: 'paying', suffixes: ['付费', '价格 多少钱', '订阅 值得吗'] },
  { angle: 'switching', suffixes: ['替代 现有工具', '换掉 之前用的', '不满意 迁移'] },
  { angle: 'frequency', suffixes: ['每天 都要用', '高频 使用', '一周 几次'] },
  // Feasibility is not only about demand: the report must name what already
  // exists, what it charges and how the new product would differ.
  { angle: 'competitor', suffixes: ['竞品 对比', '替代方案 有哪些', '定价 方案 对比'] },
];

/** Long enough to keep the nouns, short enough for an engine to parse. */
const SUBJECT_MAX = 24;

/**
 * Search engines answer a paragraph with noise. Take the pitch's first clause
 * (its title) and cap it, so "独立开发者的'可验证收入动作'优先级看板：…一段话"
 * becomes "独立开发者的可验证收入动作优先级看板" instead of a 100-char query.
 */
export function condenseIdea(idea: string): string {
  const cleaned = idea
    .replace(/\s+/g, ' ')
    .replace(/[「」『』“”"'（）()【】\[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned === '') return '';
  if (cleaned.length <= SUBJECT_MAX) return cleaned;

  const clause = cleaned.split(/[：:，,。；;！!？?\n]/)[0]?.trim() ?? '';
  const base = clause.length >= 4 ? clause : cleaned;
  if (base.length <= SUBJECT_MAX) return base;

  const slice = base.slice(0, SUBJECT_MAX);
  const lastSpace = slice.lastIndexOf(' ');
  return (lastSpace >= 8 ? slice.slice(0, lastSpace) : slice).trim();
}

/**
 * Build one group per signal class. An empty idea has nothing to search for,
 * so it yields no groups rather than queries that begin with a space. A query
 * that collides with an earlier one (possible when the idea itself contains a
 * template suffix) is dropped from the later group.
 */
export function buildAngles(idea: string): AngleGroup[] {
  // Collapse whitespace so the same pitch typed twice yields one query, and
  // condense long pitches: an engine cannot search a paragraph.
  const subject = condenseIdea(idea);
  if (subject === '') return [];

  const seen = new Set<string>();
  const groups: AngleGroup[] = [];

  for (const template of TEMPLATES) {
    const queries: string[] = [];
    for (const suffix of template.suffixes) {
      const query = `${subject} ${suffix}`;
      if (seen.has(query)) continue;
      seen.add(query);
      queries.push(query);
    }
    if (queries.length > 0) groups.push({ angle: template.angle, queries });
  }

  return groups;
}

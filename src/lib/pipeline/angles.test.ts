import { describe, expect, it } from 'vitest';

import { buildAngles, condenseIdea } from './angles';

const IDEA = '跨境库存同步';

describe('buildAngles', () => {
  it('covers the five signal classes and the competitor scan', () => {
    const groups = buildAngles(IDEA);
    expect(groups.map((group) => group.angle)).toEqual([
      'problem',
      'seeking',
      'paying',
      'switching',
      'frequency',
      'competitor',
    ]);
  });

  it('gives every class 2–3 Chinese queries built from the idea', () => {
    for (const group of buildAngles(IDEA)) {
      expect(group.queries.length).toBeGreaterThanOrEqual(2);
      expect(group.queries.length).toBeLessThanOrEqual(3);
      for (const query of group.queries) {
        expect(query.startsWith(`${IDEA} `)).toBe(true);
        expect(query).toMatch(/[\u4e00-\u9fff]/);
      }
    }
  });

  it('never repeats a query, within a class or across classes', () => {
    const queries = buildAngles(IDEA).flatMap((group) => group.queries);
    expect(new Set(queries).size).toBe(queries.length);
    expect(queries.length).toBeGreaterThanOrEqual(13);
  });

  it('is deterministic and collapses whitespace in the idea', () => {
    expect(buildAngles(`  ${IDEA}\n `)).toEqual(buildAngles(IDEA));
  });

  it('returns nothing for a blank idea', () => {
    expect(buildAngles('   ')).toEqual([]);
  });

  it('does not repeat a query when the idea already contains a template suffix', () => {
    const queries = buildAngles('库存同步 太麻烦').flatMap((group) => group.queries);
    expect(new Set(queries).size).toBe(queries.length);
  });
});


describe('condenseIdea', () => {
  it('keeps a short idea unchanged', () => {
    expect(condenseIdea('跨境库存同步')).toBe('跨境库存同步');
  });

  it('reduces a paragraph to its title clause', () => {
    const idea =
      "独立开发者的'可验证收入动作'优先级看板：独立开发者在 GitHub issue 里自述：没有 Upwork Connects、没有 Stripe 支付链接，渠道一个个失效没人管";
    expect(condenseIdea(idea)).toBe('独立开发者的 可验证收入动作 优先级看板');
  });

  it('caps a long unpunctuated pitch', () => {
    expect(condenseIdea('跨境卖家多平台库存同步超卖提醒工具以及自动补货预测功能').length).toBeLessThanOrEqual(24);
  });
});

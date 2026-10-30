import { describe, expect, it } from 'vitest';

import { buildAngles } from './angles';

const IDEA = '跨境库存同步';

describe('buildAngles', () => {
  it('covers the five signal classes', () => {
    const groups = buildAngles(IDEA);
    expect(groups.map((group) => group.angle)).toEqual([
      'problem',
      'seeking',
      'paying',
      'switching',
      'frequency',
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
    expect(queries.length).toBeGreaterThanOrEqual(10);
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

import { describe, expect, it } from 'vitest';

import type { DimensionScore } from '@/lib/scoring/types';

import {
  escapeMarkdown,
  reportMarkdownFilename,
  toMarkdown,
  type MarkdownInput,
  type MarkdownReport,
} from './to-markdown';
import { REPORT_SECTIONS, type ReportSectionBody } from './validate';

function body(text = '一条有引用的论断', evidenceIds = [1]): ReportSectionBody {
  return { claims: [{ text, evidenceIds }], unknowns: [] };
}

function sections(
  overrides: Record<string, ReportSectionBody> = {},
): Record<string, ReportSectionBody> {
  const base: Record<string, ReportSectionBody> = {};
  for (const section of REPORT_SECTIONS) base[section] = body(`${section} 的论断`);
  return { ...base, ...overrides };
}

const CREATED_AT = new Date(2026, 9, 29);

const SCORES: DimensionScore[] = [
  { dimension: 'needs', points: 16, rationale: '独立来源 4 个', evidenceIds: [] },
  {
    dimension: 'payment',
    points: 8,
    rationale: '已付费证据 1 条，无可核实价格页，封顶 10',
    evidenceIds: [],
  },
  { dimension: 'gap', points: 10, rationale: '直接竞品 3 个、竞品差评 0 条', evidenceIds: [] },
  { dimension: 'acquisition', points: 10, rationale: '2 档 × 5 → 10 分', evidenceIds: [] },
  { dimension: 'profit', points: 5, rationale: '1 档 × 5 → 5 分', evidenceIds: [] },
  { dimension: 'feasibility', points: 10, rationale: '2 档 × 5 → 10 分', evidenceIds: [] },
  { dimension: 'longevity', points: 3, rationale: '持续使用证据 2 条', evidenceIds: [] },
];

function input(overrides: Partial<MarkdownInput> = {}): MarkdownInput {
  const base: MarkdownInput = {
    idea: { title: '跨境卖家库存同步' },
    report: {
      runId: 42,
      sections: sections(),
      rubricTotal: 62,
      grade: 'C',
      decision: '建议先验证，再开发',
      createdAt: CREATED_AT,
    },
    scores: SCORES,
    evidenceMap: {
      1: {
        platform: '小红书',
        publishedAt: new Date(2026, 1, 18),
        sourceUrl: 'https://www.xiaohongshu.com/explore/abc',
        supports: '存在手工同步问题',
        doesNotProve: '不能证明愿意付费',
      },
    },
  };

  return { ...base, ...overrides };
}

describe('toMarkdown', () => {
  it('writes the title, decision, score and credibility as the headline', () => {
    const markdown = toMarkdown(input());

    expect(markdown).toContain('# 跨境卖家库存同步');
    expect(markdown).toContain('**决策**：建议先验证，再开发');
    expect(markdown).toContain('**总分**：62 / 100');
    expect(markdown).toContain('**可信度**：C');
    expect(markdown).toContain('_报告生成于 2026-10-29 · run #42_');
  });

  it('renders all eight sections in report order', () => {
    const markdown = toMarkdown(input());
    const headings = [
      '## 一、执行摘要',
      '## 二、需求证据',
      '## 三、竞品调查',
      '## 四、机会排名',
      '## 五、最佳方向',
      '## 六、财务模型',
      '## 七、14 天验证计划',
      '## 八、最终决策',
    ];

    let previous = -1;
    for (const heading of headings) {
      const at = markdown.indexOf(heading);
      expect(at).toBeGreaterThan(previous);
      previous = at;
    }
  });

  it('keeps an uncited claim out of the body', () => {
    const draft = sections({
      summary: {
        claims: [
          { text: '有引用的事实', evidenceIds: [1] },
          { text: '没有依据的猜测', evidenceIds: [] },
        ],
        unknowns: [],
      },
    });

    const markdown = toMarkdown(input({ report: { ...input().report, sections: draft } }));

    expect(markdown).toContain('有引用的事实 [e1]');
    expect(markdown).not.toContain('没有依据的猜测');
  });

  it('formats the score table from the stored rubric rows', () => {
    const markdown = toMarkdown(input());

    expect(markdown).toContain('| 维度 | 得分 | 满分 | 依据 |');
    expect(markdown).toContain('| 真实需求 | 16 | 20 | 独立来源 4 个 |');
    expect(markdown).toContain('| 长期潜力 | 3 | 5 | 持续使用证据 2 条 |');
  });

  it('lists a repeated unknown only once', () => {
    const repeated = '未收集竞品差评';
    const draft = sections({
      summary: { claims: [{ text: '摘要', evidenceIds: [1] }], unknowns: [repeated] },
      evidence: {
        claims: [{ text: '证据', evidenceIds: [1] }],
        unknowns: [repeated, '缺少长期留存数据'],
      },
    });

    const markdown = toMarkdown(input({ report: { ...input().report, sections: draft } }));
    const occurrences = markdown.split(repeated).length - 1;

    expect(occurrences).toBe(1);
    expect(markdown).toContain('缺少长期留存数据');
  });

  it('escapes table and emphasis characters in claims', () => {
    const draft = sections({
      summary: { claims: [{ text: '价格 | 渠道 * 关键', evidenceIds: [1] }], unknowns: [] },
    });

    const markdown = toMarkdown(input({ report: { ...input().report, sections: draft } }));

    expect(markdown).toContain('价格 \\| 渠道 \\* 关键');
  });

  it('writes one footnote per cited evidence, with platform, date and URL', () => {
    const draft = sections({
      summary: { claims: [{ text: '摘要', evidenceIds: [2, 1] }], unknowns: [] },
      evidence: { claims: [{ text: '证据', evidenceIds: [1] }], unknowns: [] },
    });
    const second = {
      platform: 'Reddit',
      publishedAt: null,
      sourceUrl: 'https://www.reddit.com/r/ecommerce/xyz',
      supports: null,
      doesNotProve: null,
    };

    const markdown = toMarkdown(
      input({
        report: { ...input().report, sections: draft },
        evidenceMap: { ...input().evidenceMap, 2: second },
      }),
    );

    expect(markdown).toContain('- [e2] Reddit · 日期未知 · https://www.reddit.com/r/ecommerce/xyz');
    expect(markdown).toContain(
      '- [e1] 小红书 · 2026-02-18 · https://www.xiaohongshu.com/explore/abc',
    );
    expect(markdown.indexOf('[e2] Reddit')).toBeLessThan(markdown.indexOf('[e1] 小红书'));
  });

  it('says a cited evidence row is unavailable instead of inventing it', () => {
    const draft = sections({
      summary: { claims: [{ text: '摘要', evidenceIds: [7] }], unknowns: [] },
    });

    const markdown = toMarkdown(input({ report: { ...input().report, sections: draft } }));

    expect(markdown).toContain('- [e7] 证据不可用（记录已被删除）');
  });

  it('still renders a degraded report with no claims', () => {
    const draft: Record<string, ReportSectionBody> = {};
    for (const section of REPORT_SECTIONS) {
      draft[section] = { claims: [], unknowns: ['本轮没有可引用的证据'] };
    }

    const markdown = toMarkdown(input({ report: { ...input().report, sections: draft } }));

    expect(markdown).toContain('（本节没有带引用的论断）');
    expect(markdown).toContain('- 本轮没有可引用的证据');
    expect(markdown.split('本轮没有可引用的证据').length - 1).toBe(1);
  });
});

describe('escapeMarkdown', () => {
  it('escapes pipes, emphasis and backslashes', () => {
    expect(escapeMarkdown('a|b*c_d`e[f]')).toBe('a\\|b\\*c\\_d\\`e\\[f\\]');
    expect(escapeMarkdown('a\\b')).toBe('a\\\\b');
  });
});

describe('reportMarkdownFilename', () => {
  it('uses the idea title and the report date', () => {
    const report: MarkdownReport = { ...input().report };

    expect(reportMarkdownFilename(report, { title: '跨境卖家库存同步' })).toBe(
      '跨境卖家库存同步-2026-10-29.md',
    );
  });

  it('strips path characters and falls back to the run id', () => {
    const report: MarkdownReport = { ...input().report };

    expect(reportMarkdownFilename(report, { title: 'a/b:c*?' })).toBe('abc-2026-10-29.md');
    expect(reportMarkdownFilename(report, { title: '///' })).toBe('demandx-run-42-2026-10-29.md');
  });
});

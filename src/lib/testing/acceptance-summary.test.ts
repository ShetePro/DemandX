import { describe, expect, it } from 'vitest';

import { renderAcceptanceSummary, type AcceptanceSummary } from './acceptance-summary';

function summary(overrides: Partial<AcceptanceSummary> = {}): AcceptanceSummary {
  return {
    mode: 'new',
    runId: 42,
    stages: {
      sources: 3,
      accepted: 3,
      rejected: 0,
      failedSources: 0,
      opportunities: 1,
      dropped: 0,
      scored: 1,
      decisions: { 建议先验证: 1 },
    },
    report: {
      id: 7,
      total: 49,
      grade: 'C',
      decision: '建议先验证，再开发',
      claims: 8,
      citations: 8,
      sections: 8,
      unknowns: 1,
    },
    timing: { S2: 7, S3: 4, S4: 6, S5: 8, total: 83 },
    calls: ['extract', 'extract', 'extract', 'cluster', 'ordinals', 'sections'],
    ...overrides,
  };
}

describe('renderAcceptanceSummary', () => {
  it('renders every stage, the verdict and the stub call sequence', () => {
    const text = renderAcceptanceSummary(summary());

    expect(text).toContain('run：#42');
    expect(text).toContain('新建 run（结束后清理）');
    expect(text).toContain('extract → extract → extract → cluster → ordinals → sections');
    expect(text).toContain('接受 3 · 拒绝 0 · 读取失败 0');
    expect(text).toContain('机会 1 · 独立性不足丢弃 0');
    expect(text).toContain('总分 49/100 · 可信度 C · 决策 建议先验证，再开发');
    expect(text).toContain('总耗时：83 ms');
    expect(text).toContain('清理策略：结束后删除自建 run 与快照');
  });

  it('carries the "not real quality" warning on every render', () => {
    for (const mode of ['new', 'existing'] as const) {
      const text = renderAcceptanceSummary(summary({ mode }));
      expect(text).toContain('不代表真实抽取质量');
      expect(text).toContain('假模型输出仅用于验证');
    }
  });

  it('sorts decisions so two runs are comparable, and shows an empty set as —', () => {
    const text = renderAcceptanceSummary(
      summary({
        stages: {
          ...summary().stages,
          decisions: { 建议放弃: 1, 建议开发: 2 },
          dropped: 2,
        },
        mode: 'existing',
      }),
    );

    expect(text).toContain('决策：建议开发 ×2；建议放弃 ×1');
    expect(text).toContain('已有 run（保留）');
    expect(text).toContain('清理策略：保留（--run）');

    const empty = renderAcceptanceSummary(
      summary({ stages: { ...summary().stages, decisions: {} } }),
    );
    expect(empty).toContain('决策：—');
  });

  it('marks a missing report as such instead of inventing numbers', () => {
    const text = renderAcceptanceSummary(
      summary({
        report: null,
        stages: { ...summary().stages, opportunities: 0, dropped: 1, scored: 0 },
      }),
    );

    expect(text).toContain('| S5/S6 报告 | 未生成 |');
    expect(text).not.toContain('总分 49/100');
  });
});

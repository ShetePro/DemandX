/**
 * Renders the acceptance script's Markdown summary. Pure on purpose: the
 * script's database work is hard to unit-test, but the numbers-to-prose step is
 * not, so this module is what the test suite pins down.
 *
 * The warning line is part of the output, not decoration: a deterministic stub
 * proves the pipeline's contract (quote gate, independence threshold, rubric
 * arithmetic, report validator, persistence) and nothing about a real model.
 */

export interface AcceptanceStageCounts {
  /** Sources the run holds; S2 reads the ones without accepted evidence. */
  sources: number;
  accepted: number;
  rejected: number;
  failedSources: number;
  opportunities: number;
  dropped: number;
  scored: number;
  /** Decision → count, exactly as S4 reported it. */
  decisions: Record<string, number>;
}

export interface AcceptanceReportCounts {
  id: number;
  /** Sum of the seven `scores.points`; S4's headline total. */
  total: number;
  grade: string;
  decision: string;
  claims: number;
  citations: number;
  sections: number;
  unknowns: number;
}

export type AcceptanceStage = 'S2' | 'S3' | 'S4' | 'S5';

export interface AcceptanceSummary {
  mode: 'new' | 'existing';
  runId: number;
  stages: AcceptanceStageCounts;
  /** `null` when no report row was written; the run then failed S5/S6. */
  report: AcceptanceReportCounts | null;
  /** Milliseconds per stage, plus the end-to-end total. */
  timing: Record<AcceptanceStage | 'total', number>;
  /** Stub calls in order, e.g. `extract → cluster → ordinals → sections`. */
  calls: readonly string[];
}

/** Decisions are free text; sorting keeps two runs comparable. */
function formatDecisions(decisions: Record<string, number>): string {
  const entries = Object.entries(decisions).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (entries.length === 0) return '—';
  return entries.map(([decision, count]) => `${decision} ×${count}`).join('；');
}

function formatMs(value: number): string {
  return `${value} ms`;
}

/**
 * Markdown, not a table alone: the warning has to travel with the numbers so a
 * pasted summary cannot be read as evidence of extraction quality.
 */
export function renderAcceptanceSummary(summary: AcceptanceSummary): string {
  const { stages, report, timing } = summary;
  const mode = summary.mode === 'new' ? '新建 run（结束后清理）' : '已有 run（保留）';

  const lines = [
    '## 全链路契约验收摘要',
    '',
    '> 假模型输出仅用于验证 S2–S6 的管道契约（闸门、独立性、评分、校验、落库），不代表真实抽取质量。',
    '',
    `- run：#${summary.runId}（${mode}）`,
    `- 来源：${stages.sources}`,
    `- 假模型调用序列：${summary.calls.length === 0 ? '—' : summary.calls.join(' → ')}`,
    `- 清理策略：${summary.mode === 'new' ? '结束后删除自建 run 与快照' : '保留（--run）'}`,
    '',
    '| 阶段 | 结果 | 耗时 |',
    '| --- | --- | ---: |',
    `| S2 抽取 | 接受 ${stages.accepted} · 拒绝 ${stages.rejected} · 读取失败 ${stages.failedSources} | ${formatMs(timing.S2)} |`,
    `| S3 聚类 | 机会 ${stages.opportunities} · 独立性不足丢弃 ${stages.dropped} | ${formatMs(timing.S3)} |`,
    `| S4 评分 | 已评分 ${stages.scored} · 决策：${formatDecisions(stages.decisions)} | ${formatMs(timing.S4)} |`,
    `| S5/S6 报告 | ${
      report === null
        ? '未生成'
        : `#${report.id} · 总分 ${report.total}/100 · 可信度 ${report.grade} · 决策 ${report.decision} · claim ${report.claims} · 引用 ${report.citations} · 未知 ${report.unknowns} · ${report.sections} 节`
    } | ${formatMs(timing.S5)} |`,
    '',
    `总耗时：${formatMs(timing.total)}`,
    '',
  ];

  return lines.join('\n');
}

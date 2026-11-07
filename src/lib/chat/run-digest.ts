import type { PipelineSummary } from '@/lib/pipeline/run';
import { loadReportPage } from '@/lib/report/read';
import { appendAssistantMessage, type AssistantMessagePart } from '@/lib/runs/repository';

export interface RunDigestReport {
  id: number;
  rubricTotal: number;
  grade: string;
  decision: string;
}

export interface RunDigestInput {
  runId: number;
  summary: PipelineSummary;
  /** The stored report, or `null` when S5/S6 never published one. */
  report: RunDigestReport | null;
  /** Set when the run ended in a failure instead of a report. */
  failure: { stage: string; message: string } | null;
}

/**
 * The chat turn a finished run leaves behind. It only repeats stored numbers —
 * sources, accepted/rejected evidence, rubric total, grade, decision, report id
 * — so the transcript continues with facts the report also cites, never with a
 * second, model-invented conclusion.
 */
export function runDigestParts(input: RunDigestInput): AssistantMessagePart[] {
  const { runId, summary, report, failure } = input;

  if (failure !== null) {
    return [
      {
        type: 'text',
        text: [
          `**run #${runId} 在 ${failure.stage} 失败**`,
          '',
          `原因：${failure.message}`,
          '',
          `已保留：采集 ${summary.sources} 个页面 · 接受证据 ${summary.accepted} 条 · 拒收 ${summary.rejected} 条。已入库的行不会回滚，修复后可以重跑。`,
        ].join('\n'),
      },
    ];
  }

  const lines = [
    `**run #${runId} 研究完成（S1–S6）**`,
    '',
    `- 采集 ${summary.sources} 个页面；接受证据 ${summary.accepted} 条、拒收 ${summary.rejected} 条；聚类 ${summary.opportunities} 个机会；评分 ${summary.scored} 个`,
  ];

  if (report !== null) {
    lines.push(
      `- 评分 ${report.rubricTotal}/100 · 可信度 ${report.grade} · 决策：${report.decision}`,
      `- 报告 #${report.id}（/runs/${runId}/report） · 逐条证据（/runs/${runId}/evidence）`,
      '',
    );
    lines.push(
      summary.accepted === 0
        ? '这次没有接受任何证据，报告里的判断都是待验证的推断。'
        : '证据已写入本会话，可以继续追问具体引文或某条信号。',
    );
  } else {
    lines.push('');
    lines.push('S5/S6 没有留下报告，这批数据只能从证据页查看。');
  }

  return [{ type: 'text', text: lines.join('\n') }];
}

/**
 * Writes the digest into the run's conversation. Best-effort like every other
 * post-run side effect: a lost message must not turn a finished run into a
 * failure, so the error is logged for the operator instead.
 */
export async function writeRunDigest(
  runId: number,
  summary: PipelineSummary,
  failure: { stage: string; message: string } | null,
): Promise<void> {
  const page = await loadReportPage(runId);
  if (!page.ok) {
    console.error(`⚠️ run ${runId} 研究结论读取失败: ${page.message}`);
    return;
  }
  if (page.value === null || page.value.threadId === null) return;

  const report = page.value.report;
  const parts = runDigestParts({
    runId,
    summary,
    report:
      report === null
        ? null
        : {
            id: report.id,
            rubricTotal: report.rubricTotal,
            grade: report.grade,
            decision: report.decision,
          },
    failure,
  });

  const written = await appendAssistantMessage(page.value.threadId, parts);
  if (!written.ok) {
    console.error(`⚠️ run ${runId} 研究结论写入对话失败: ${written.message}`);
  }
}

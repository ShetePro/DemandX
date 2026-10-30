'use server';

import { loadReportPage } from '@/lib/report/read';
import { reportTitle } from '@/lib/report/sections';
import {
  reportMarkdownFilename,
  toMarkdown,
  type MarkdownEvidence,
  type MarkdownReport,
} from '@/lib/report/to-markdown';

export type ExportErrorCode = 'INVALID_INPUT' | 'NOT_FOUND' | 'STORAGE_FAILED';

export type ExportReportResult =
  | { ok: true; value: { filename: string; content: string } }
  | { ok: false; code: ExportErrorCode; message: string };

/**
 * Build the Markdown export from the stored report rather than from the
 * client's copy: a download must be the durable record, and the evidence
 * footnotes must not depend on what a tab happens to hold.
 */
export async function exportReportAction(rawRunId: unknown): Promise<ExportReportResult> {
  const runId =
    typeof rawRunId === 'number' && Number.isSafeInteger(rawRunId) && rawRunId > 0
      ? rawRunId
      : null;
  if (runId === null) {
    return { ok: false, code: 'INVALID_INPUT', message: 'run id 无效' };
  }

  const loaded = await loadReportPage(runId);
  if (!loaded.ok) {
    return { ok: false, code: 'STORAGE_FAILED', message: loaded.message };
  }
  if (loaded.value === null) {
    return { ok: false, code: 'NOT_FOUND', message: `run ${runId} 不存在` };
  }

  const data = loaded.value;
  if (data.report === null) {
    return { ok: false, code: 'NOT_FOUND', message: '报告尚未生成，暂无可导出的内容' };
  }

  const report: MarkdownReport = {
    runId,
    sections: data.report.sections,
    rubricTotal: data.report.rubricTotal,
    grade: data.report.grade,
    decision: data.report.decision,
    createdAt: data.report.createdAt,
  };
  const idea = { title: reportTitle(data.idea) };

  const evidenceMap: Record<number, MarkdownEvidence> = {};
  for (const [key, item] of Object.entries(data.evidenceMap)) {
    evidenceMap[Number(key)] = {
      platform: item.platform,
      publishedAt: item.publishedAt,
      sourceUrl: item.sourceUrl,
      supports: item.supports,
      doesNotProve: item.doesNotProve,
    };
  }

  return {
    ok: true,
    value: {
      filename: reportMarkdownFilename(report, idea),
      content: toMarkdown({ idea, report, scores: data.scores, evidenceMap }),
    },
  };
}

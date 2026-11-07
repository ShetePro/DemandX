import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/report/read', () => ({ loadReportPage: vi.fn() }));
vi.mock('@/lib/runs/repository', () => ({ appendAssistantMessage: vi.fn() }));

import type { AssistantMessagePart } from '@/lib/runs/repository';

import { runDigestParts } from './run-digest';

const SUMMARY = {
  sources: 18,
  skipped: 1,
  accepted: 6,
  rejected: 2,
  opportunities: 2,
  scored: 2,
  reportId: 152,
};

const REPORT = { id: 152, rubricTotal: 61, grade: 'C', decision: '建议先验证，再开发' };

function textOf(parts: readonly AssistantMessagePart[]): string {
  return parts
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('\n');
}

describe('runDigestParts', () => {
  it('repeats the stored run numbers and links the report', () => {
    const text = textOf(
      runDigestParts({ runId: 236, summary: SUMMARY, report: REPORT, failure: null }),
    );

    expect(text).toContain('run #236 研究完成');
    expect(text).toContain('接受证据 6 条');
    expect(text).toContain('评分 61/100');
    expect(text).toContain('可信度 C');
    expect(text).toContain('建议先验证，再开发');
    expect(text).toContain('报告 #152（/runs/236/report）');
    expect(text).toContain('逐条证据（/runs/236/evidence）');
  });

  it('says a zero-evidence run leaves conclusions unverified', () => {
    const text = textOf(
      runDigestParts({
        runId: 236,
        summary: { ...SUMMARY, accepted: 0, rejected: 0 },
        report: { ...REPORT, rubricTotal: 32, grade: 'D', decision: '建议放弃' },
        failure: null,
      }),
    );

    expect(text).toContain('这次没有接受任何证据');
  });

  it('does not invent a report when S5/S6 stored none', () => {
    const text = textOf(
      runDigestParts({ runId: 7, summary: SUMMARY, report: null, failure: null }),
    );

    expect(text).toContain('没有留下报告');
    expect(text).not.toContain('/runs/7/report');
  });

  it('keeps the failure stage, reason and stored rows', () => {
    const text = textOf(
      runDigestParts({
        runId: 7,
        summary: SUMMARY,
        report: null,
        failure: { stage: 'S3', message: 'S3 失败：模型返回为空' },
      }),
    );

    expect(text).toContain('run #7 在 S3 失败');
    expect(text).toContain('模型返回为空');
    expect(text).toContain('接受证据 6 条');
  });
});

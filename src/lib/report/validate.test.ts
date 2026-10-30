import { describe, expect, it } from 'vitest';

import {
  REPORT_SECTIONS,
  validateReport,
  type ReportClaim,
  type ReportDraft,
  type ReportIssue,
  type ReportSectionBody,
} from './validate';

function claim(text: string, evidenceIds: number[] = [1]): ReportClaim {
  return { text, evidenceIds };
}

function section(
  claims: ReportClaim[] = [claim('有引用的论断')],
  unknowns: string[] = [],
): ReportSectionBody {
  return { claims, unknowns };
}

/** A complete, passing report; each test overrides the one dimension it breaks. */
function report(overrides: Partial<ReportDraft> = {}): ReportDraft {
  const sections: Record<string, ReportSectionBody> = {};
  for (const key of REPORT_SECTIONS) sections[key] = section();

  return { sections, rubricTotal: 68, scoresTotal: 68, ...overrides };
}

function expectIssues(draft: ReportDraft): ReportIssue[] {
  const result = validateReport(draft);
  if (result.ok) throw new Error('expected the report to be rejected');
  return result.issues;
}

function codes(draft: ReportDraft): string[] {
  return expectIssues(draft).map((issue) => issue.code);
}

describe('validateReport', () => {
  it('accepts a complete report', () => {
    expect(validateReport(report())).toEqual({ ok: true });
  });

  it('does not care about the order the sections were stored in', () => {
    const reversed: Record<string, ReportSectionBody> = {};
    for (const key of [...REPORT_SECTIONS].reverse()) reversed[key] = section();

    expect(validateReport(report({ sections: reversed }))).toEqual({ ok: true });
  });

  it('rejects a report missing one of the eight parts', () => {
    const sections = report().sections;
    delete sections.competitors;

    expect(expectIssues(report({ sections }))).toEqual([
      { code: 'missing_section', path: 'sections.competitors' },
    ]);
  });

  it('rejects a claim without any citation', () => {
    const sections = report().sections;
    sections.evidence = section([claim('有引用'), claim('没有引用', [])]);

    expect(expectIssues(report({ sections }))).toEqual([
      { code: 'claim_missing_evidence', path: 'sections.evidence.claims[1].evidenceIds' },
    ]);
  });

  it('rejects a claim whose text is blank', () => {
    const sections = report().sections;
    sections.summary = section([claim('   ')]);

    expect(expectIssues(report({ sections }))).toEqual([
      { code: 'claim_missing_text', path: 'sections.summary.claims[0].text' },
    ]);
  });

  it('rejects a headline total that disagrees with the scores', () => {
    expect(expectIssues(report({ rubricTotal: 68, scoresTotal: 67 }))).toEqual([
      { code: 'total_mismatch', path: 'rubricTotal' },
    ]);
  });

  it('rejects a rubric total above the 100-point ceiling', () => {
    // Both sides agree, so only the range rule may fire.
    expect(codes(report({ rubricTotal: 101, scoresTotal: 101 }))).toEqual([
      'rubric_total_out_of_range',
    ]);
  });

  it('rejects a claim that repeats a fact the run marked unknown', () => {
    const sections = report().sections;
    sections.finance = section([claim('未知的 ARR 预计达到 10 万')], ['未知的 ARR']);

    expect(expectIssues(report({ sections }))).toEqual([
      { code: 'unknown_leaked', path: 'sections.finance.claims[0].text' },
    ]);
  });

  it('ignores blank unknowns instead of rejecting every claim', () => {
    const sections = report().sections;
    sections.plan = section([claim('两周内完成访谈')], ['', '   ']);

    expect(validateReport(report({ sections }))).toEqual({ ok: true });
  });

  it('returns every problem in one pass, in section order', () => {
    const sections = report().sections;
    delete (sections as Record<string, ReportSectionBody>).ranking;
    sections.summary = section([claim('未知的 ARR 预计达到 10 万')], ['未知的 ARR']);
    sections.evidence = section([claim('没有引用', [])]);

    const issues = expectIssues(report({ sections, rubricTotal: 101, scoresTotal: 67 }));

    expect(issues.map((issue) => issue.code)).toEqual([
      'unknown_leaked',
      'claim_missing_evidence',
      'missing_section',
      'rubric_total_out_of_range',
      'total_mismatch',
    ]);
  });

  it('rejects a section whose claims are not a list', () => {
    const sections = report().sections;
    sections.decision = { claims: 'oops', unknowns: [] } as unknown as ReportSectionBody;

    expect(expectIssues(report({ sections }))).toEqual([
      { code: 'invalid_section', path: 'sections.decision' },
    ]);
  });
});

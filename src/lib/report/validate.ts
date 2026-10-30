/**
 * Structural gate of the eight-part report (spec §4.4). Pure: no database, no
 * clock, no LLM — it only answers "is this report admissible?" so S6 can refuse
 * to publish before anything is written to `reports`.
 *
 * The validator deliberately does not check whether the numbers are *right*:
 * that is the rubric's job. It checks that every part is present, that no claim
 * is uncited, that the headline total matches the scores, and that a fact the
 * run could not establish never appears in the body as if it were one.
 */

/** The eight parts, in the order the report presents them. */
export const REPORT_SECTIONS = [
  'summary',
  'evidence',
  'competitors',
  'ranking',
  'bestDirection',
  'finance',
  'plan',
  'decision',
] as const;

export type ReportSection = (typeof REPORT_SECTIONS)[number];

export interface ReportClaim {
  /** The assertion, in the report's language. Empty text is not a claim. */
  text: string;
  /** Evidence rows backing it; an uncited claim may not appear in the body. */
  evidenceIds: number[];
}

export interface ReportSectionBody {
  claims: ReportClaim[];
  /** What this part could not establish, rendered as 未知 rather than guessed. */
  unknowns: string[];
}

/** What the validator reads: the stored shape of `reports` plus the score total. */
export interface ReportDraft {
  sections: Record<string, ReportSectionBody>;
  /** The headline rubric total, 0–100. */
  rubricTotal: number;
  /** Sum of `scores.points` for the same run. */
  scoresTotal: number;
}

export interface ReportIssue {
  /** Stable machine code; rendered by the job that refuses to publish. */
  code: string;
  /** Where it is, e.g. `sections.evidence.claims[2].text`. */
  path: string;
}

export type ReportValidation = { ok: true } | { ok: false; issues: ReportIssue[] };

/** The rubric is 100 points, so a headline above it cannot be a real sum. */
const MAX_TOTAL = 100;

/**
 * Every unknown of the whole report, trimmed and with empties dropped. Empty
 * strings would otherwise "leak" into every claim, because `includes('')` is
 * always true.
 */
function collectUnknowns(sections: Record<string, ReportSectionBody>): string[] {
  const unknowns: string[] = [];

  for (const section of REPORT_SECTIONS) {
    const body = sections[section];
    if (body === undefined || !Array.isArray(body.unknowns)) continue;

    for (const unknown of body.unknowns) {
      if (typeof unknown !== 'string') continue;
      const trimmed = unknown.trim();
      if (trimmed !== '' && !unknowns.includes(trimmed)) unknowns.push(trimmed);
    }
  }

  return unknowns;
}

function issuesOfClaim(
  claim: ReportClaim,
  index: number,
  section: ReportSection,
  unknowns: readonly string[],
): ReportIssue[] {
  const path = `sections.${section}.claims[${index}]`;
  const issues: ReportIssue[] = [];

  if (typeof claim !== 'object' || claim === null) {
    return [{ code: 'invalid_claim', path }];
  }

  if (typeof claim.text !== 'string' || claim.text.trim() === '') {
    issues.push({ code: 'claim_missing_text', path: `${path}.text` });
  }

  if (!Array.isArray(claim.evidenceIds) || claim.evidenceIds.length === 0) {
    issues.push({ code: 'claim_missing_evidence', path: `${path}.evidenceIds` });
  }

  // A fact the run marked unknown must never reappear inside a claim, whatever
  // citation sits next to it: that is a fabricated fact with a real footnote.
  if (typeof claim.text === 'string') {
    const leaked = unknowns.find((unknown) => claim.text.includes(unknown));
    if (leaked !== undefined) {
      issues.push({ code: 'unknown_leaked', path: `${path}.text` });
    }
  }

  return issues;
}

/**
 * Validate the report's structure. All issues are returned in one pass, in
 * section order, so a failing run reports everything the operator must fix
 * instead of one problem per retry.
 */
export function validateReport(report: ReportDraft): ReportValidation {
  const issues: ReportIssue[] = [];
  const unknowns = collectUnknowns(report.sections);

  for (const section of REPORT_SECTIONS) {
    const body = report.sections[section];

    if (body === undefined) {
      issues.push({ code: 'missing_section', path: `sections.${section}` });
      continue;
    }

    // `sections` comes from `jsonb`, so a malformed row is possible at runtime.
    if (typeof body !== 'object' || body === null || !Array.isArray(body.claims)) {
      issues.push({ code: 'invalid_section', path: `sections.${section}` });
      continue;
    }

    body.claims.forEach((claim, index) => {
      issues.push(...issuesOfClaim(claim, index, section, unknowns));
    });
  }

  if (
    !Number.isFinite(report.rubricTotal) ||
    report.rubricTotal < 0 ||
    report.rubricTotal > MAX_TOTAL
  ) {
    issues.push({ code: 'rubric_total_out_of_range', path: 'rubricTotal' });
  }

  // Catches a report whose headline drifted from the scores it claims to sum.
  if (report.rubricTotal !== report.scoresTotal) {
    issues.push({ code: 'total_mismatch', path: 'rubricTotal' });
  }

  return issues.length === 0 ? { ok: true } : { ok: false, issues };
}

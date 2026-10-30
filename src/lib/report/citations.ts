/**
 * Claim → citation expansion, kept free of the database so the pure callers
 * (S5's metric, the report page) can count links without opening a pool.
 */

import { REPORT_SECTIONS, type ReportSectionBody } from './validate';

export interface CitationRow {
  reportPath: string;
  evidenceId: number;
}

/**
 * `citations` is keyed by `(report_id, report_path)`, so each evidence link
 * needs its own path. The first citation of a claim uses the plain claim path
 * (`summary.claims[0]`); extra ones add the evidence index, which still parses
 * back to the same claim.
 */
export function citationRows(sections: Record<string, ReportSectionBody>): CitationRow[] {
  const rows: CitationRow[] = [];

  for (const section of REPORT_SECTIONS) {
    const body = sections[section];
    if (body === undefined) continue;

    body.claims.forEach((claim, claimIndex) => {
      const base = `${section}.claims[${claimIndex}]`;
      [...new Set(claim.evidenceIds)].forEach((evidenceId, evidenceIndex) => {
        rows.push({
          reportPath: evidenceIndex === 0 ? base : `${base}.evidenceIds[${evidenceIndex}]`,
          evidenceId,
        });
      });
    });
  }

  return rows;
}

/** How many citation rows a report will write; S5 reports it as a metric. */
export function countCitations(sections: Record<string, ReportSectionBody>): number {
  return citationRows(sections).length;
}

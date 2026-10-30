/**
 * S6's write side: the report row and its citation trail, in one transaction.
 * The validator runs before this module is reached, so anything written here is
 * already admissible; what remains is keeping the two tables consistent — a
 * report row without its citations is a report nobody can audit.
 */

import { eq } from 'drizzle-orm';

import { db } from '@/lib/db/client';
import { citations, reports } from '@/lib/db/schema';
import { fail, ok, type Result } from '@/lib/quota/types';
import type { CredibilityGrade } from '@/lib/scoring/credibility';
import type { Decision } from '@/lib/scoring/decision';

import { citationRows } from './citations';
import { collectUnknowns, type ReportSectionBody } from './validate';

export interface SaveReportInput {
  runId: number;
  sections: Record<string, ReportSectionBody>;
  /** S4's `sum(points)`; stored as the headline and checked against it. */
  total: number;
  grade: CredibilityGrade;
  decision: Decision;
}

/** SQLSTATE only: postgres.js errors also carry query text and parameters. */
function storageFailure<T>(action: string, error: unknown): Result<T> {
  const state = (error as { code?: unknown } | null)?.code;
  const detail = typeof state === 'string' ? ` (SQLSTATE ${state})` : '';
  return fail('STORAGE_FAILED', `${action}失败${detail}`);
}

/**
 * Upsert by run (one report per run) and rebuild the citation trail from the
 * claims. Re-running S6 must leave exactly the links the new body has, so the
 * delete happens inside the same transaction as the insert.
 */
export async function saveReport(input: SaveReportInput): Promise<Result<{ reportId: number }>> {
  const { sections, total, grade, decision } = input;
  const unknowns = collectUnknowns(sections);
  const links = citationRows(sections);

  try {
    const reportId = await db.transaction(async (tx) => {
      const saved = await tx
        .insert(reports)
        .values({
          runId: input.runId,
          sections,
          rubricTotal: total,
          credibilityGrade: grade,
          decision,
          unknowns,
        })
        .onConflictDoUpdate({
          target: reports.runId,
          set: { sections, rubricTotal: total, credibilityGrade: grade, decision, unknowns },
        })
        .returning({ id: reports.id });

      const row = saved[0];
      if (!row) throw new Error('reports upsert returned no row');

      await tx.delete(citations).where(eq(citations.reportId, row.id));
      if (links.length > 0) {
        await tx.insert(citations).values(links.map((link) => ({ reportId: row.id, ...link })));
      }

      return row.id;
    });

    return ok({ reportId });
  } catch (error) {
    return storageFailure('保存报告', error);
  }
}

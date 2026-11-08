/**
 * Read model of the report page: one run, its stored report, the rubric rows of
 * the opportunity the report was written from, and only the evidence the report
 * actually cites.
 *
 * Two rules keep the page honest:
 * - Scores are read back, never recomputed; the opportunity is the one S5 chose
 *   (`pickBestScored`), not "the first row that looks right".
 * - The browser receives `before`/`quote`/`after` fragments cut from the stored
 *   snapshot, never the full page. A citation whose evidence row is gone stays
 *   absent from the map, and the page says so instead of inventing a quote.
 */

import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';

import { db } from '@/lib/db/client';
import { citations, evidence, ideas, reports, runs, sources } from '@/lib/db/schema';
import type { QuoteHighlight } from '@/lib/evidence/highlight';
import { sliceQuoteHighlight } from '@/lib/evidence/highlight';
import type { Signal } from '@/lib/evidence/schema';
import { readSnapshotText, SnapshotError } from '@/lib/evidence/snapshot';
import { ok, type Result } from '@/lib/quota/types';
import { pickBestScored, type ScoredOpportunity } from '@/lib/scoring/best';
import type { DimensionScore } from '@/lib/scoring/types';
import { listOpportunities } from '@/lib/runs/opportunities-repository';
import type { OpportunityRow } from '@/lib/runs/opportunities-repository';
import { listScores } from '@/lib/runs/scores-repository';

import { REPORT_SECTIONS, type ReportClaim, type ReportSectionBody } from './validate';

/** SQLSTATE only: postgres.js errors also carry query text and parameters. */
function storageFailure<T>(action: string, error: unknown): Result<T> {
  const state = (error as { code?: unknown } | null)?.code;
  const detail = typeof state === 'string' ? ` (SQLSTATE ${state})` : '';
  return { ok: false, code: 'STORAGE_FAILED', message: `${action}失败${detail}` };
}

const claimSchema = z.object({
  text: z.string().trim().min(1),
  evidenceIds: z.array(z.number().int().positive()).default([]),
});

/**
 * One section's shell. Claims are kept as `unknown` so one malformed claim is
 * dropped on its own instead of erasing the rest of the section.
 */
const sectionShellSchema = z.object({
  claims: z.array(z.unknown()).default([]),
  unknowns: z.array(z.string().trim().min(1)).default([]),
  // The stored contract has always carried inferences; dropping them here made
  // the page look emptier than the report actually is.
  inferences: z.array(z.string().trim().min(1)).default([]),
});

const sectionsBlobSchema = z.record(z.string(), z.unknown());

/**
 * `reports.sections` is `jsonb`, so a hand-edited row can hold anything. Each
 * section and each claim is parsed independently; anything that does not match
 * the stored contract is dropped rather than crashing the page.
 */
function parseSections(value: unknown): Record<string, ReportSectionBody> {
  const parsed: Record<string, ReportSectionBody> = {};

  const blob = sectionsBlobSchema.safeParse(value);
  if (!blob.success) return parsed;

  for (const section of REPORT_SECTIONS) {
    const shell = sectionShellSchema.safeParse(blob.data[section]);
    if (!shell.success) continue;

    const claims: ReportClaim[] = [];
    for (const candidate of shell.data.claims) {
      const claim = claimSchema.safeParse(candidate);
      if (!claim.success) continue;
      claims.push({
        text: claim.data.text,
        evidenceIds: [...new Set(claim.data.evidenceIds)],
      });
    }

    const inferences = [...new Set(shell.data.inferences)];
    parsed[section] = {
      claims,
      unknowns: [...new Set(shell.data.unknowns)],
      ...(inferences.length === 0 ? {} : { inferences }),
    };
  }

  return parsed;
}

export interface ReportRecord {
  id: number;
  sections: Record<string, ReportSectionBody>;
  rubricTotal: number;
  grade: string;
  decision: string;
  createdAt: Date;
}

/** A cited evidence row plus the server-cut fragments the browser may see. */
export interface ReportEvidenceItem {
  id: number;
  quote: string;
  platform: string;
  publishedAt: Date | null;
  signal: Signal;
  firstHand: boolean;
  supports: string | null;
  doesNotProve: string | null;
  rejectedReason: string | null;
  sourceUrl: string;
  highlight: QuoteHighlight | null;
}

export interface ReportPageData {
  runId: number;
  threadId: number | null;
  status: string;
  stage: string | null;
  idea: { title: string; rawInput: string };
  /** `null` means the run exists but S5/S6 has not published a report yet. */
  report: ReportRecord | null;
  /** The seven rows of the opportunity the report was written from. */
  scores: readonly DimensionScore[];
  /** Keyed by evidence id; only cited evidence is present. */
  evidenceMap: Record<number, ReportEvidenceItem>;
}

interface RunRow {
  id: number;
  threadId: number | null;
  status: string;
  stage: string | null;
  title: string;
  rawInput: string;
}

async function readRun(runId: number): Promise<RunRow | null> {
  const rows = await db
    .select({
      id: runs.id,
      threadId: runs.threadId,
      status: runs.status,
      stage: runs.stage,
      title: ideas.title,
      rawInput: ideas.rawInput,
    })
    .from(runs)
    .innerJoin(ideas, eq(runs.ideaId, ideas.id))
    .where(eq(runs.id, runId))
    .limit(1);

  return rows[0] ?? null;
}

/** Whether the run has published a report; used to decide if the monitor links to it. */
export async function hasReport(runId: number): Promise<Result<boolean>> {
  if (!Number.isSafeInteger(runId) || runId <= 0) return ok(false);

  try {
    const rows = await db
      .select({ id: reports.id })
      .from(reports)
      .where(eq(reports.runId, runId))
      .limit(1);
    return ok(rows.length > 0);
  } catch (error) {
    return storageFailure('读取报告', error);
  }
}

async function readReport(runId: number): Promise<ReportRecord | null> {
  const rows = await db
    .select({
      id: reports.id,
      sections: reports.sections,
      rubricTotal: reports.rubricTotal,
      grade: reports.credibilityGrade,
      decision: reports.decision,
      createdAt: reports.createdAt,
    })
    .from(reports)
    .where(eq(reports.runId, runId))
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  return {
    id: row.id,
    sections: parseSections(row.sections),
    rubricTotal: Number.isFinite(row.rubricTotal) ? row.rubricTotal : 0,
    grade: row.grade,
    decision: row.decision,
    createdAt: row.createdAt,
  };
}

/** The scores of the opportunity S5 picked, read through the same ranking rule. */
async function readBestScores(runId: number): Promise<Result<readonly DimensionScore[]>> {
  const listed = await listOpportunities(runId);
  if (!listed.ok) return listed;

  const candidates: ScoredOpportunity<OpportunityRow>[] = [];
  for (const opportunity of listed.value) {
    const scores = await listScores(opportunity.id);
    if (!scores.ok) return scores;
    candidates.push({ opportunity, scores: scores.value });
  }

  return ok(pickBestScored(candidates)?.scores ?? []);
}

interface CitedEvidenceRow {
  id: number;
  quote: string;
  quoteOffset: number | null;
  platform: string;
  publishedAt: Date | null;
  signal: Signal;
  firstHand: boolean;
  supports: string | null;
  doesNotProve: string | null;
  rejectedReason: string | null;
  sourceUrl: string;
  contentHash: string;
}

async function readCitedEvidence(reportId: number): Promise<CitedEvidenceRow[]> {
  const rows = await db
    .select({
      id: evidence.id,
      quote: evidence.quote,
      quoteOffset: evidence.quoteOffset,
      platform: evidence.platform,
      publishedAt: evidence.publishedAt,
      signal: evidence.signal,
      firstHand: evidence.firstHand,
      supports: evidence.supports,
      doesNotProve: evidence.doesNotProve,
      rejectedReason: evidence.rejectedReason,
      sourceUrl: sources.canonicalUrl,
      contentHash: sources.contentHash,
    })
    .from(citations)
    .innerJoin(evidence, eq(citations.evidenceId, evidence.id))
    .innerJoin(sources, eq(evidence.sourceId, sources.id))
    .where(eq(citations.reportId, reportId))
    .orderBy(asc(evidence.id));

  // Several claims may cite the same row; the panel shows it once.
  const unique = new Map<number, CitedEvidenceRow>();
  for (const row of rows) {
    if (!unique.has(row.id)) unique.set(row.id, row);
  }
  return [...unique.values()];
}

/**
 * Cut each quote from its snapshot once per content hash. A missing snapshot
 * degrades to the stored quote without a mark; any other file error is real and
 * fails the page rather than silently blanking every highlight.
 */
async function withHighlights(rows: CitedEvidenceRow[]): Promise<ReportEvidenceItem[]> {
  const snapshots = new Map<string, string | null>();
  const items: ReportEvidenceItem[] = [];

  for (const row of rows) {
    let highlight: QuoteHighlight | null = null;

    if (row.quoteOffset !== null) {
      let text = snapshots.get(row.contentHash);
      if (text === undefined) {
        try {
          text = await readSnapshotText(row.contentHash);
        } catch (error) {
          if (!(error instanceof SnapshotError)) throw error;
          text = null;
        }
        snapshots.set(row.contentHash, text);
      }

      if (text !== null) {
        highlight = sliceQuoteHighlight(text, row.quoteOffset, row.quote);
      }
    }

    items.push({ ...row, highlight });
  }

  return items;
}

/**
 * Everything `/runs/[runId]/report` renders. `null` means the run itself does
 * not exist; a missing report is `report: null` on a real run, which is the
 * honest empty state rather than a 404.
 */
export async function loadReportPage(runId: number): Promise<Result<ReportPageData | null>> {
  if (!Number.isSafeInteger(runId) || runId <= 0) return ok(null);

  try {
    const run = await readRun(runId);
    if (run === null) return ok(null);

    const base = {
      runId: run.id,
      threadId: run.threadId,
      status: run.status,
      stage: run.stage,
      idea: { title: run.title, rawInput: run.rawInput },
    };

    const report = await readReport(runId);
    if (report === null) {
      return ok({ ...base, report: null, scores: [], evidenceMap: {} });
    }

    const scores = await readBestScores(runId);
    if (!scores.ok) return scores;

    const cited = await readCitedEvidence(report.id);
    const evidenceMap: Record<number, ReportEvidenceItem> = {};
    for (const item of await withHighlights(cited)) {
      evidenceMap[item.id] = item;
    }

    return ok({ ...base, report, scores: scores.value, evidenceMap });
  } catch (error) {
    return storageFailure('读取报告', error);
  }
}

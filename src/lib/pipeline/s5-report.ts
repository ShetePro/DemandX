/**
 * S5 + S6 as one stage: pick the best-scored opportunity, write the eight-part
 * report from its accepted evidence, then validate and persist it. The report
 * model writes prose; the total, the grade and the decision come from S4's
 * stored `scores`, re-derived through the same pure functions S4 used.
 *
 * A run with no surviving opportunity still gets a report: the "证据不足" shell
 * carries S4's fallback verdict (D → 建议放弃) and passes the validator, which
 * is what keeps a dead-end run readable instead of leaving the page empty.
 */

import type { LlmPort } from '@/lib/llm/port';
import { assertAlive } from '@/lib/quota/deadline';
import { ok, type Result } from '@/lib/quota/types';
import {
  buildEmptyReport,
  buildEvidenceOnlyReport,
  buildReportSections,
  DEADLINE_REASON,
  NO_EVIDENCE_REASON,
  type ReportDerivation,
  type ReportEvidence,
  type ReportSections,
} from '@/lib/report/assemble';
import { countCitations } from '@/lib/report/citations';
import type { SaveReportInput } from '@/lib/report/persist';
import { validateReport } from '@/lib/report/validate';
import type { ScoringEvidenceRow } from '@/lib/runs/evidence-repository';
import type {
  AcceptedEvidence,
  OpportunityRow,
} from '@/lib/runs/opportunities-repository';
import { pickBestScored, type ScoredOpportunity } from '@/lib/scoring/best';
import type { CredibilityGrade } from '@/lib/scoring/credibility';
import type { Decision } from '@/lib/scoring/decision';
import type { DimensionScore } from '@/lib/scoring/types';
import { deriveVerdict } from '@/lib/scoring/verdict';

import type { RunContext, StageOutcome } from './context';
import { MIN_INDEPENDENT_SOURCES } from './s3-cluster';

export interface ReportS5Summary {
  reportId: number;
  /** `null` when no opportunity survived S3, i.e. the report is the shell. */
  opportunityId: number | null;
  total: number;
  grade: CredibilityGrade;
  decision: Decision;
  claims: number;
  citations: number;
}

export interface ReportDeps {
  llm: LlmPort;
  repo: {
    listOpportunities(runId: number): Promise<Result<OpportunityRow[]>>;
    /** The seven `scores` rows S4 wrote for one opportunity. */
    listScores(opportunityId: number): Promise<Result<DimensionScore[]>>;
    /** Rows behind `evidenceIds`; rejected rows are filtered here. */
    listEvidenceByIds(ids: readonly number[]): Promise<Result<ScoringEvidenceRow[]>>;
    /** Accepted rows for the run, used when no cluster cleared the gate. */
    listAcceptedEvidence(runId: number): Promise<Result<AcceptedEvidence[]>>;
    saveReport(input: SaveReportInput): Promise<Result<{ reportId: number }>>;
  };
  /** Optional audit log; its failure never fails the stage. */
  onEvent?: (type: string, payload: Record<string, unknown>) => Promise<void>;
  now?: () => Date;
}

/**
 * Telemetry must never abort the report: a stored report row is the durable
 * record even if writing the event fails.
 */
async function emit(
  deps: Pick<ReportDeps, 'onEvent'>,
  type: string,
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    await deps.onEvent?.(type, payload);
  } catch {
    // Intentionally swallowed: the report row is the durable record.
  }
}

interface Candidate {
  opportunity: OpportunityRow;
  scores: readonly DimensionScore[];
}

/**
 * S4's ranking rule lives in `pickBestScored` so the report page reads the same
 * opportunity; this wrapper only adds the two reads the rule needs.
 */
async function pickBest(
  repo: ReportDeps['repo'],
  runId: number,
): Promise<Result<Candidate | null>> {
  const listed = await repo.listOpportunities(runId);
  if (!listed.ok) return listed;

  const candidates: ScoredOpportunity<OpportunityRow>[] = [];
  for (const opportunity of listed.value) {
    const scores = await repo.listScores(opportunity.id);
    if (!scores.ok) return scores;
    candidates.push({ opportunity, scores: scores.value });
  }

  return ok(pickBestScored(candidates));
}

/** Only accepted rows may be cited, so the whitelist is built after this filter. */
async function reportEvidenceOf(
  repo: ReportDeps['repo'],
  candidate: Candidate,
): Promise<Result<ReportEvidence[]>> {
  const fetched = await repo.listEvidenceByIds(candidate.opportunity.evidenceIds);
  if (!fetched.ok) return fetched;

  return ok(
    fetched.value
      .filter((row) => row.rejectedReason === null)
      .map((row) => ({
        id: row.id,
        sourceId: row.sourceId,
        signal: row.signal,
        platform: row.platform,
        quote: row.quote,
        supports: row.supports ?? null,
      })),
  );
}

/**
 * One `stage.started`/`stage.finished` pair for S5 and one for S6. The stage
 * owns both because the boundary sits inside it: S5 ends when the body exists,
 * S6 begins at the validator. Emitting them here keeps the failure attributed
 * to the half that actually died.
 */
export async function reportS5(
  ctx: RunContext,
  deps: ReportDeps,
): Promise<StageOutcome<ReportS5Summary>> {
  const now = deps.now ?? (() => new Date());

  await emit(deps, 'stage.started', { stage: 'S5' });

  const picked = await pickBest(deps.repo, ctx.runId);
  if (!picked.ok) {
    await emit(deps, 'stage.finished', { stage: 'S5', status: 'failed', code: picked.code });
    return picked;
  }

  const candidate = picked.value;

  let evidence: Result<ReportEvidence[]>;
  if (candidate === null) {
    const accepted = await deps.repo.listAcceptedEvidence(ctx.runId);
    if (!accepted.ok) {
      await emit(deps, 'stage.finished', { stage: 'S5', status: 'failed', code: accepted.code });
      return accepted;
    }
    evidence = ok(
      accepted.value.map((row) => ({
        id: row.id,
        sourceId: row.sourceId,
        signal: row.signal,
        platform: row.platform,
        quote: row.quote,
        supports: row.supports ?? null,
      })),
    );
  } else {
    evidence = await reportEvidenceOf(deps.repo, candidate);
  }
  if (!evidence.ok) {
    await emit(deps, 'stage.finished', { stage: 'S5', status: 'failed', code: evidence.code });
    return evidence;
  }

  // S4 counted `n` over the opportunity's accepted rows, so the same count here
  // reproduces its grade exactly; `independentSources` is the clustering-time
  // number and can differ after a quote is rejected.
  const independentSources = new Set(evidence.value.map((row) => row.sourceId)).size;
  const verdict = deriveVerdict(candidate?.scores ?? [], independentSources);
  const derivation: ReportDerivation = {
    scores: candidate?.scores ?? [],
    ...verdict,
    ...(candidate === null && evidence.value.length > 0
      ? {
          // The five-way decision has no "insufficient" value; 暂缓 is the
          // honest one when the corpus exists but cannot support a direction.
          decision: {
            decision: '建议暂缓' as const,
            reason: '没有方向达到 3 个独立来源的门槛，现有证据只够形成假设。',
            nextStep: '先补齐 3 个独立来源或做小范围预售，再决定是否开发。',
          },
        }
      : {}),
  };

  // Past the deadline no new model call may start (spec §8). The report still
  // gets written from what is already stored, as the degraded shell.
  const alive = assertAlive(ctx.deadlineAt, now());
  let sections: ReportSections;
  if (!alive.ok) {
    sections = buildEmptyReport(DEADLINE_REASON);
  } else if (candidate === null) {
    if (evidence.value.length === 0) {
      sections = buildEmptyReport(NO_EVIDENCE_REASON);
    } else {
      // No opportunity, but real evidence: let the model write the eight
      // sections as explicit inference instead of leaving 3–8 blank.
      const built = await buildReportSections({
        llm: deps.llm,
        idea: ctx.idea,
        exploratory: true,
        opportunity: { name: null, positioning: null, independentSources },
        evidence: evidence.value,
        derivation,
      });
      sections = built.ok
        ? built.value
        : buildEvidenceOnlyReport(
            evidence.value,
            `这次只找到 ${evidence.value.length} 条真实证据（来自 ${independentSources} 个来源）。判断一个方向至少要有 ${MIN_INDEPENDENT_SOURCES} 个不同来源说同一件事，所以现在还不能下结论；下面列出已经找到的证据，供你先判断。`,
          );
    }
  } else {
    const built = await buildReportSections({
      llm: deps.llm,
      opportunity: {
        name: candidate?.opportunity.name ?? null,
        positioning: candidate?.opportunity.positioning ?? null,
        independentSources,
      },
      evidence: evidence.value,
      derivation,
    });
    if (!built.ok) {
      await emit(deps, 'stage.finished', { stage: 'S5', status: 'failed', code: built.code });
      return built;
    }
    sections = built.value;
  }

  const claims = Object.values(sections.sections).reduce(
    (sum, body) => sum + body.claims.length,
    0,
  );
  const citations = countCitations(sections.sections);
  await emit(deps, 'stage.finished', {
    stage: 'S5',
    status: 'finished',
    opportunityId: candidate?.opportunity.id ?? null,
    total: derivation.total,
    grade: derivation.credibility.grade,
    decision: derivation.decision.decision,
    claims,
  });

  await emit(deps, 'stage.started', { stage: 'S6' });

  const validation = validateReport({
    sections: sections.sections,
    rubricTotal: derivation.total,
    scoresTotal: derivation.total,
  });
  if (!validation.ok) {
    const message = `报告校验失败：${validation.issues
      .map((issue) => `${issue.path}(${issue.code})`)
      .join('; ')}`;
    await emit(deps, 'stage.finished', {
      stage: 'S6',
      status: 'failed',
      code: 'REPORT_INVALID',
      issues: validation.issues,
    });
    return { ok: false, code: 'REPORT_INVALID', message, issues: validation.issues };
  }

  const saved = await deps.repo.saveReport({
    runId: ctx.runId,
    sections: sections.sections,
    total: derivation.total,
    grade: derivation.credibility.grade,
    decision: derivation.decision.decision,
  });
  if (!saved.ok) {
    await emit(deps, 'stage.finished', { stage: 'S6', status: 'failed', code: saved.code });
    return saved;
  }

  const summary: ReportS5Summary = {
    reportId: saved.value.reportId,
    opportunityId: candidate?.opportunity.id ?? null,
    total: derivation.total,
    grade: derivation.credibility.grade,
    decision: derivation.decision.decision,
    claims,
    citations,
  };

  await emit(deps, 'stage.finished', {
    stage: 'S6',
    status: 'finished',
    reportId: summary.reportId,
    citations,
  });
  await emit(deps, 'report.ready', {
    reportId: summary.reportId,
    opportunityId: summary.opportunityId,
    total: summary.total,
    grade: summary.grade,
    decision: summary.decision,
    claims: summary.claims,
    citations: summary.citations,
  });

  return ok(summary);
}

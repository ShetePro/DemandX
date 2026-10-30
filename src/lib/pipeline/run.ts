import type { AppErrorCode, RunContext } from './context';
import type { CollectDeps } from './s1-collect';
import { collectS1 } from './s1-collect';
import type { ExtractDeps } from './s2-extract';
import { extractS2 } from './s2-extract';
import type { ClusterDeps } from './s3-cluster';
import { clusterS3 } from './s3-cluster';
import type { ScoreDeps } from './s4-score';
import { scoreS4 } from './s4-score';
import type { ReportDeps } from './s5-report';
import { reportS5 } from './s5-report';

/**
 * What one run reports once every stage has had its turn. `sources` and
 * `skipped` belong to S1, `accepted`/`rejected` to S2, `opportunities` to S3,
 * `scored` to S4 and `reportId` to S6; a failure in a later stage does not
 * erase the numbers an earlier one already stored.
 */
export interface PipelineSummary {
  sources: number;
  skipped: number;
  accepted: number;
  rejected: number;
  opportunities: number;
  scored: number;
  reportId: number | null;
}

/**
 * `StageOutcome` plus the metrics produced before a failure. The caller has to
 * write a terminal event even when the run fails, and "S1 stored two pages" is
 * a fact the event must not lose; keeping it in `message` alone would force the
 * worker to parse prose. `issues` is S6's structured rejection detail.
 */
export type PipelineOutcome =
  | { ok: true; value: PipelineSummary }
  | {
      ok: false;
      code: AppErrorCode;
      message: string;
      summary: PipelineSummary;
      issues?: unknown;
    };

/**
 * Every stage's dependencies, injected whole. Stages stay namespaced because
 * their repositories answer different questions (sources, evidence, clusters,
 * scores, reports), and a flat object would collide on `repo`, `now` and
 * `onEvent`.
 */
export interface PipelineDeps {
  s1: Omit<CollectDeps, 'onEvent'>;
  s2: Omit<ExtractDeps, 'onEvent'>;
  s3: Omit<ClusterDeps, 'onEvent'>;
  s4: Omit<ScoreDeps, 'onEvent'>;
  s5: Omit<ReportDeps, 'onEvent'>;
  onEvent?: (type: string, payload: Record<string, unknown>) => Promise<void>;
}

/**
 * Telemetry must never abort a run: the stored rows are the durable record, and
 * every stage already treats a failed event write this way.
 */
async function emit(
  deps: Pick<PipelineDeps, 'onEvent'>,
  type: string,
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    await deps.onEvent?.(type, payload);
  } catch {
    // Intentionally swallowed: a lost event is not a lost source.
  }
}

const EMPTY_SUMMARY: PipelineSummary = {
  sources: 0,
  skipped: 0,
  accepted: 0,
  rejected: 0,
  opportunities: 0,
  scored: 0,
  reportId: null,
};

/**
 * S1 → S6, one `stage.started`/`stage.finished` pair per stage. A stage only
 * starts when the one before it succeeded, because each reads what the previous
 * wrote; a failure returns immediately and never rolls back stored rows.
 *
 * S5 and S6 share one stage module (the validator must run before anything is
 * persisted), so `reportS5` emits its own two pairs: that keeps a validation
 * failure attributed to S6 instead of retroactively failing S5.
 */
export async function runPipeline(ctx: RunContext, deps: PipelineDeps): Promise<PipelineOutcome> {
  let summary: PipelineSummary = EMPTY_SUMMARY;
  const progress = { accepted: 0, rejected: 0 };

  await emit(deps, 'stage.started', { stage: 'S1' });

  const collected = await collectS1(ctx, {
    ...deps.s1,
    onEvent: (type, payload) => emit(deps, type, payload),
  });

  if (!collected.ok) {
    await emit(deps, 'stage.finished', {
      stage: 'S1',
      status: 'failed',
      code: collected.code,
    });
    return {
      ok: false,
      code: collected.code,
      message: collected.message,
      summary,
    };
  }

  summary = { ...summary, sources: collected.value.sources, skipped: collected.value.skipped };
  await emit(deps, 'stage.finished', { stage: 'S1', status: 'finished', ...collected.value });

  await emit(deps, 'stage.started', { stage: 'S2' });

  const extracted = await extractS2(ctx, {
    ...deps.s2,
    onEvent: async (type, payload) => {
      if (type === 'stage.progress' && payload.stage === 'S2') {
        if (typeof payload.accepted === 'number') progress.accepted = payload.accepted;
        if (typeof payload.rejected === 'number') progress.rejected = payload.rejected;
      }
      await emit(deps, type, payload);
    },
  });

  summary = extracted.ok
    ? { ...summary, accepted: extracted.value.accepted, rejected: extracted.value.rejected }
    : { ...summary, accepted: progress.accepted, rejected: progress.rejected };

  if (!extracted.ok) {
    await emit(deps, 'stage.finished', {
      stage: 'S2',
      status: 'failed',
      code: extracted.code,
      accepted: summary.accepted,
      rejected: summary.rejected,
    });
    return {
      ok: false,
      code: extracted.code,
      message: `S2 失败：${extracted.message}（已保留 sources=${summary.sources} skipped=${summary.skipped} accepted=${summary.accepted} rejected=${summary.rejected}）`,
      summary,
    };
  }

  await emit(deps, 'stage.finished', {
    stage: 'S2',
    status: 'finished',
    ...extracted.value,
  });

  await emit(deps, 'stage.started', { stage: 'S3' });

  const clustered = await clusterS3(ctx, {
    ...deps.s3,
    onEvent: (type, payload) => emit(deps, type, payload),
  });

  if (!clustered.ok) {
    await emit(deps, 'stage.finished', { stage: 'S3', status: 'failed', code: clustered.code });
    return {
      ok: false,
      code: clustered.code,
      message: `S3 失败：${clustered.message}（已保留 sources=${summary.sources} accepted=${summary.accepted}）`,
      summary,
    };
  }

  summary = { ...summary, opportunities: clustered.value.opportunities };
  await emit(deps, 'stage.finished', { stage: 'S3', status: 'finished', ...clustered.value });

  await emit(deps, 'stage.started', { stage: 'S4' });

  const scored = await scoreS4(ctx, {
    ...deps.s4,
    onEvent: (type, payload) => emit(deps, type, payload),
  });

  if (!scored.ok) {
    await emit(deps, 'stage.finished', { stage: 'S4', status: 'failed', code: scored.code });
    return {
      ok: false,
      code: scored.code,
      message: `S4 失败：${scored.message}（已保留 sources=${summary.sources} accepted=${summary.accepted} opportunities=${summary.opportunities}）`,
      summary,
    };
  }

  summary = { ...summary, scored: scored.value.opportunities };
  await emit(deps, 'stage.finished', { stage: 'S4', status: 'finished', ...scored.value });

  // No `stage.started` here: `reportS5` spans S5 (assembly) and S6
  // (validation + persistence) and emits both pairs itself.
  const reported = await reportS5(ctx, {
    ...deps.s5,
    onEvent: (type, payload) => emit(deps, type, payload),
  });

  if (!reported.ok) {
    return {
      ok: false,
      code: reported.code,
      message: reported.message,
      summary,
      ...(reported.issues === undefined ? {} : { issues: reported.issues }),
    };
  }

  summary = { ...summary, reportId: reported.value.reportId };

  return { ok: true, value: summary };
}

import type { AppErrorCode, RunContext } from './context';
import type { CollectDeps } from './s1-collect';
import { collectS1 } from './s1-collect';
import type { ExtractDeps } from './s2-extract';
import { extractS2 } from './s2-extract';

/**
 * What one run reports once both stages have had their turn. `sources` and
 * `skipped` belong to S1, `accepted` and `rejected` to S2; a failure in S2 does
 * not erase the S1 half.
 */
export interface PipelineSummary {
  sources: number;
  skipped: number;
  accepted: number;
  rejected: number;
}

/**
 * `StageOutcome` plus the metrics produced before a failure. The caller has to
 * write a terminal event even when the run fails, and "S1 stored two pages" is
 * a fact the event must not lose; keeping it in `message` alone would force the
 * worker to parse prose.
 */
export type PipelineOutcome =
  | { ok: true; value: PipelineSummary }
  | { ok: false; code: AppErrorCode; message: string; summary: PipelineSummary };

/**
 * Both stages' dependencies, injected whole. `s1`/`s2` stay namespaced because
 * their repositories answer different questions (sources vs evidence), and a
 * flat object would collide on `repo`, `now`, and `onEvent`.
 */
export interface PipelineDeps {
  s1: Omit<CollectDeps, 'onEvent'>;
  s2: Omit<ExtractDeps, 'onEvent'>;
  onEvent?: (type: string, payload: Record<string, unknown>) => Promise<void>;
}

/**
 * Telemetry must never abort a run: the stored sources and evidence are the
 * durable record, and S1 already treats a failed event write this way.
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

const EMPTY_SUMMARY: PipelineSummary = { sources: 0, skipped: 0, accepted: 0, rejected: 0 };

/**
 * S1 then S2, with one `stage.started`/`stage.finished` pair per stage. S2 only
 * starts when S1 succeeded, because extraction has nothing to read otherwise.
 *
 * S2's failure does not roll back S1: sources are already in the store, and the
 * returned summary says how many. Accepted/rejected counts on that path are the
 * last values S2 reported through `stage.progress`, so a chain that died after
 * three pages still reports the evidence those pages produced.
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

  return { ok: true, value: summary };
}

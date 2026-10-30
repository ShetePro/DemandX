import { buildExtractionPrompt } from '@/lib/evidence/prompt';
import { gateQuote } from '@/lib/evidence/quote-gate';
import { MAX_ITEMS_PER_PAGE, evidenceExtractionSchema } from '@/lib/evidence/schema';
import type { LlmPort } from '@/lib/llm/port';
import { assertAlive } from '@/lib/quota/deadline';
import { ok, type Result } from '@/lib/quota/types';
import type {
  ExtractionSource,
  InsertEvidenceInput,
  InsertEvidenceOutcome,
} from '@/lib/runs/evidence-repository';

import type { RunContext, StageOutcome } from './context';

/** The chain is considered down after this many failures in a row. */
export const MAX_CONSECUTIVE_FAILURES = 5;

/** A rate needs a sample before it means anything: 1 failure of 1 is not "50%". */
export const MIN_FAILURE_SAMPLE = 5;

/** More than half the calls failing means the profile cannot carry the stage. */
export const FAILURE_RATE_LIMIT = 0.5;

/** Observability threshold from the build plan; above it the run is suspicious. */
export const HIGH_REJECTION_RATE = 0.2;

/** Below this many judged quotes the rejection rate is reported but not warned. */
export const MIN_REJECTION_SAMPLE = 10;

/** Extraction is cheap per page but not free; this caps a runaway source list. */
export const DEFAULT_MAX_PAGES = 120;

export interface S2Summary {
  /** Rows newly stored with `rejected_reason = null`. */
  accepted: number;
  /** Rows newly stored with the gate's reason and the offending quote. */
  rejected: number;
  /** Pages whose snapshot could not be read or whose extraction call failed. */
  failedSources: number;
}

export interface ExtractDeps {
  llm: LlmPort;
  repo: {
    /** Pages with no accepted evidence yet, oldest first. */
    listSources(runId: number, limit: number): Promise<Result<ExtractionSource[]>>;
    insertEvidence(input: InsertEvidenceInput): Promise<Result<InsertEvidenceOutcome>>;
  };
  /** Snapshot text, or `null` when it is missing; a thrown error counts as missing. */
  readSnapshot(source: ExtractionSource): Promise<string | null>;
  /** Optional audit log; its failure never fails the run. */
  onEvent?: (type: string, payload: Record<string, unknown>) => Promise<void>;
  now?: () => Date;
  /** Defaults to `DEFAULT_MAX_PAGES`; also the `listSources` limit. */
  maxPages?: number;
}

/**
 * Telemetry must never abort extraction: evidence already stored stays stored
 * even if writing the event fails.
 */
async function emit(
  deps: Pick<ExtractDeps, 'onEvent'>,
  type: string,
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    await deps.onEvent?.(type, payload);
  } catch {
    // Intentionally swallowed: the evidence row is the durable record.
  }
}

/**
 * S2: one bulk-profile extraction call per page, every quote held to the
 * snapshot by `gateQuote`, one progress event per page, and a warning when the
 * gate rejects too much. Rejected candidates are stored, not dropped: the
 * evidence page shows the quote and the reason, which is how a prompt regression
 * is diagnosed without re-running the stage.
 *
 * A single bad page never ends the stage. The stage stops early only when the
 * LLM is unusable — five failures in a row, or more than half the calls failing
 * once there is a sample — because every later call would fail the same way.
 */
export async function extractS2(
  ctx: RunContext,
  deps: ExtractDeps,
): Promise<StageOutcome<S2Summary>> {
  const now = deps.now ?? (() => new Date());

  // Stage entrance check, before listing or reading anything.
  const alive = assertAlive(ctx.deadlineAt, now());
  if (!alive.ok) return alive;

  const limit = deps.maxPages ?? DEFAULT_MAX_PAGES;
  const listed = await deps.repo.listSources(ctx.runId, limit);
  if (!listed.ok) return listed;

  const sources = listed.value;
  const total = sources.length;

  let accepted = 0;
  let rejected = 0;
  let failedSources = 0;
  let done = 0;
  let llmCalls = 0;
  let llmFailures = 0;
  let consecutiveFailures = 0;

  async function progress(): Promise<void> {
    await emit(deps, 'stage.progress', { stage: 'S2', done, total, accepted, rejected });
  }

  for (const source of sources) {
    const alivePage = assertAlive(ctx.deadlineAt, now());
    if (!alivePage.ok) return alivePage;

    let snapshot: string | null;
    try {
      snapshot = await deps.readSnapshot(source);
    } catch (error) {
      snapshot = null;
      await emit(deps, 'source.failed', {
        stage: 'S2',
        sourceId: source.id,
        url: source.canonicalUrl,
        platform: source.platform,
        code: 'SNAPSHOT_FAILED',
        message: error instanceof Error ? error.message : String(error),
      });
    }

    if (snapshot === null) {
      // No snapshot means no corpus to verify a quote against; never call the
      // LLM for it, since an unverifiable quote would have to be rejected anyway.
      failedSources += 1;
      await emit(deps, 'source.failed', {
        stage: 'S2',
        sourceId: source.id,
        url: source.canonicalUrl,
        platform: source.platform,
        code: 'SNAPSHOT_MISSING',
      });
      done += 1;
      await progress();
      continue;
    }

    llmCalls += 1;
    const extracted = await deps.llm.structured(
      evidenceExtractionSchema,
      buildExtractionPrompt({
        url: source.canonicalUrl,
        platform: source.platform,
        text: snapshot,
      }),
      { profile: 'bulk' },
    );

    if (!extracted.ok) {
      llmFailures += 1;
      consecutiveFailures += 1;
      failedSources += 1;
      await emit(deps, 'source.failed', {
        stage: 'S2',
        sourceId: source.id,
        url: source.canonicalUrl,
        platform: source.platform,
        code: extracted.code,
        message: extracted.message,
      });
      done += 1;
      await progress();

      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        return {
          ok: false,
          code: 'LLM_UNAVAILABLE',
          message: `连续 ${consecutiveFailures} 次抽取失败：${extracted.message}`,
        };
      }
      if (llmCalls >= MIN_FAILURE_SAMPLE && llmFailures / llmCalls > FAILURE_RATE_LIMIT) {
        return {
          ok: false,
          code: 'LLM_UNAVAILABLE',
          message: `抽取失败率 ${llmFailures}/${llmCalls} 超过 ${
            FAILURE_RATE_LIMIT * 100
          }%：${extracted.message}`,
        };
      }
      continue;
    }

    consecutiveFailures = 0;

    for (const item of extracted.value.data.items.slice(0, MAX_ITEMS_PER_PAGE)) {
      const gate = gateQuote(snapshot, item.quote);

      const inserted = await deps.repo.insertEvidence({
        runId: ctx.runId,
        sourceId: source.id,
        quote: item.quote,
        quoteOffset: gate.ok ? gate.offset : null,
        platform: source.platform,
        publishedAt: item.publishedAt === null ? null : new Date(item.publishedAt),
        signal: item.signal,
        firstHand: item.firstHand,
        priceMentioned: item.priceMentioned,
        supports: item.supports,
        doesNotProve: item.doesNotProve,
        rejectedReason: gate.ok ? null : gate.reason,
      });
      // Losing the store is not one bad page: nothing after it can be trusted.
      if (!inserted.ok) return inserted;

      // A duplicate verdict was counted when it was first stored; counting it
      // again would make a retried stage look like it found new evidence.
      if (!inserted.value.inserted) continue;
      if (gate.ok) accepted += 1;
      else rejected += 1;
    }

    done += 1;
    await progress();
  }

  const judged = accepted + rejected;
  if (judged >= MIN_REJECTION_SAMPLE) {
    const rate = rejected / judged;
    if (rate > HIGH_REJECTION_RATE) {
      await emit(deps, 'stage.warning', { stage: 'S2', code: 'high_rejection_rate', rate });
    }
  }

  return ok({ accepted, rejected, failedSources });
}

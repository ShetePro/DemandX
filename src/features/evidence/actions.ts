'use server';

import { eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';

import { db } from '@/lib/db/client';
import { evidence, sources } from '@/lib/db/schema';
import { gateQuote } from '@/lib/evidence/quote-gate';
import { readSnapshotText, SnapshotError } from '@/lib/evidence/snapshot';

export type EvidenceActionErrorCode =
  'INVALID_INPUT' | 'NOT_FOUND' | 'QUOTE_MISMATCH' | 'SNAPSHOT_MISSING' | 'STORAGE_FAILED';

export type EvidenceActionResult<T> =
  { ok: true; value: T } | { ok: false; code: EvidenceActionErrorCode; message: string };

export interface RejectEvidenceOutcome {
  id: number;
  rejectedReason: 'manual';
}

export interface RestoreEvidenceOutcome {
  id: number;
  quoteOffset: number | null;
  /** `false` when the row was already accepted and nothing changed. */
  changed: boolean;
}

function failure<T>(code: EvidenceActionErrorCode, message: string): EvidenceActionResult<T> {
  return { ok: false, code, message };
}

function evidenceId(raw: unknown): number | null {
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw <= 0) return null;
  return raw;
}

function storageFailure<T>(action: string, error: unknown): EvidenceActionResult<T> {
  const state = (error as { code?: unknown } | null)?.code;
  const detail = typeof state === 'string' ? ` (SQLSTATE ${state})` : '';
  return failure('STORAGE_FAILED', `${action}失败${detail}`);
}

/**
 * Operator rejection. `manual` is a distinct reason from the automatic gate
 * failures, so the evidence page can say why a row was dropped. The row itself
 * is kept — a rejected quote is still proof of what the model tried to pass
 * off as evidence — and scoring is not touched here (P5 consumes the flag).
 */
export async function rejectEvidenceAction(
  rawId: unknown,
): Promise<EvidenceActionResult<RejectEvidenceOutcome>> {
  const id = evidenceId(rawId);
  if (id === null) return failure('INVALID_INPUT', '证据 id 无效');

  try {
    const rows = await db
      .update(evidence)
      .set({ rejectedReason: 'manual' })
      .where(eq(evidence.id, id))
      .returning({ id: evidence.id, runId: evidence.runId });

    const row = rows[0];
    if (!row) return failure('NOT_FOUND', '证据不存在');

    revalidatePath(`/runs/${row.runId}/evidence`);
    return { ok: true, value: { id: row.id, rejectedReason: 'manual' } };
  } catch (error) {
    return storageFailure('驳回证据', error);
  }
}

/**
 * Undo a rejection, but only if the quote still occurs in the snapshot. A
 * manually rejected row goes through the same gate as extraction: restoring
 * must not let a stale or tampered quote back into scoring. `quote_offset` is
 * refreshed to the gate's result so the highlight stays exact.
 */
export async function restoreEvidenceAction(
  rawId: unknown,
): Promise<EvidenceActionResult<RestoreEvidenceOutcome>> {
  const id = evidenceId(rawId);
  if (id === null) return failure('INVALID_INPUT', '证据 id 无效');

  let row:
    | {
        id: number;
        runId: number;
        quote: string;
        quoteOffset: number | null;
        rejectedReason: string | null;
        contentHash: string;
      }
    | undefined;

  try {
    const rows = await db
      .select({
        id: evidence.id,
        runId: evidence.runId,
        quote: evidence.quote,
        quoteOffset: evidence.quoteOffset,
        rejectedReason: evidence.rejectedReason,
        contentHash: sources.contentHash,
      })
      .from(evidence)
      .innerJoin(sources, eq(evidence.sourceId, sources.id))
      .where(eq(evidence.id, id))
      .limit(1);
    row = rows[0];
  } catch (error) {
    return storageFailure('读取证据', error);
  }

  if (!row) return failure('NOT_FOUND', '证据不存在或来源缺失');
  if (row.rejectedReason === null) {
    return { ok: true, value: { id: row.id, quoteOffset: row.quoteOffset, changed: false } };
  }

  let snapshot: string;
  try {
    snapshot = await readSnapshotText(row.contentHash);
  } catch (error) {
    if (error instanceof SnapshotError) {
      return failure('SNAPSHOT_MISSING', '快照缺失，无法校验引文');
    }
    return storageFailure('读取快照', error);
  }

  const gate = gateQuote(snapshot, row.quote);
  if (!gate.ok) {
    return failure(
      'QUOTE_MISMATCH',
      gate.reason === 'empty_quote' ? '引文长度无效，未恢复' : '引文已不在快照中，未恢复',
    );
  }

  try {
    const rows = await db
      .update(evidence)
      .set({ rejectedReason: null, quoteOffset: gate.offset })
      .where(eq(evidence.id, id))
      .returning({ id: evidence.id });

    if (!rows[0]) return failure('NOT_FOUND', '证据不存在');

    revalidatePath(`/runs/${row.runId}/evidence`);
    return { ok: true, value: { id: row.id, quoteOffset: gate.offset, changed: true } };
  } catch (error) {
    return storageFailure('恢复证据', error);
  }
}

import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';

import { db } from '@/lib/db/client';
import { runEvents, runs } from '@/lib/db/schema';
import { fail, ok, type Result } from '@/lib/quota/types';

/** At most this many rows are rendered; the queue is a work list, not an archive. */
export const NEEDS_HUMAN_LIMIT = 50;

/** Payload of one `source.needs_human` event; older rows may lack fields. */
const needsHumanPayloadSchema = z.object({
  url: z.string().optional(),
  platform: z.string().optional(),
  reason: z.string().optional(),
});

export interface NeedsHumanItem {
  eventId: number;
  runId: number;
  url: string | null;
  platform: string | null;
  reason: string | null;
  createdAt: Date;
  runStatus: string;
  runStage: string | null;
}

/** SQLSTATE only: postgres.js errors also carry query text and parameters. */
function storageFailure<T>(action: string, error: unknown): Result<T> {
  const state = (error as { code?: unknown } | null)?.code;
  const detail = typeof state === 'string' ? ` (SQLSTATE ${state})` : '';
  return fail('STORAGE_FAILED', `${action}失败${detail}`);
}

/**
 * Newest first across all runs. Two rows for the same run are expected: they
 * are two different blocked pages, and retrying the run collects both.
 */
export async function listNeedsHuman(limit = NEEDS_HUMAN_LIMIT): Promise<Result<NeedsHumanItem[]>> {
  const capped =
    Number.isInteger(limit) && limit > 0 ? Math.min(limit, NEEDS_HUMAN_LIMIT) : NEEDS_HUMAN_LIMIT;

  try {
    const rows = await db
      .select({
        eventId: runEvents.id,
        runId: runEvents.runId,
        payload: runEvents.payload,
        createdAt: runEvents.createdAt,
        runStatus: runs.status,
        runStage: runs.stage,
      })
      .from(runEvents)
      .innerJoin(runs, eq(runEvents.runId, runs.id))
      .where(eq(runEvents.type, 'source.needs_human'))
      .orderBy(desc(runEvents.id))
      .limit(capped);

    return ok(
      rows.map((row) => {
        const payload = needsHumanPayloadSchema.safeParse(row.payload);
        const fields = payload.success ? payload.data : {};
        return {
          eventId: row.eventId,
          runId: row.runId,
          url: fields.url ?? null,
          platform: fields.platform ?? null,
          reason: fields.reason ?? null,
          createdAt: row.createdAt,
          runStatus: row.runStatus,
          runStage: row.runStage,
        };
      }),
    );
  } catch (error) {
    return storageFailure('读取待人工队列', error);
  }
}

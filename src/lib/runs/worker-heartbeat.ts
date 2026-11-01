import { z } from 'zod';

import { getSetting, setSetting } from '@/lib/settings/store';

const HEARTBEAT_KEY = 'worker-heartbeat';

/** A worker that has not checked in for this long is treated as stopped. */
export const WORKER_STALE_MS = 45_000;

const heartbeatSchema = z.object({ at: z.string() });

export type WorkerStatus = {
  online: boolean;
  /** Last check-in, or null when the worker has never run. */
  at: Date | null;
};

/**
 * A queued run is indistinguishable from a stalled one without knowing whether
 * a worker exists. The worker writes this heartbeat; the thread page reads it
 * to say "worker 未运行" instead of leaving "排队中" up forever.
 */
export async function touchWorkerHeartbeat(now: Date = new Date()): Promise<void> {
  await setSetting(HEARTBEAT_KEY, { at: now.toISOString() });
}

export async function readWorkerStatus(now: Date = new Date()): Promise<WorkerStatus> {
  const stored = await getSetting(HEARTBEAT_KEY, heartbeatSchema);
  if (!stored.ok || stored.value === null) return { online: false, at: null };

  const at = new Date(stored.value.at);
  if (Number.isNaN(at.getTime())) return { online: false, at: null };

  return { online: now.getTime() - at.getTime() <= WORKER_STALE_MS, at };
}

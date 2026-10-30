import { fail, ok, type Result } from './types';

/**
 * Wall-clock watchdog checked at every stage entrance. `null` means the run has
 * no deadline. Reaching the deadline exactly counts as expired: no new external
 * request may start at that instant, the pipeline switches to a degraded report.
 */
export function assertAlive(deadlineAt: Date | null, now: Date = new Date()): Result<void> {
  if (deadlineAt === null) return ok(undefined);

  if (now.getTime() >= deadlineAt.getTime()) {
    return fail('DEADLINE_EXCEEDED', `已超过截止时间 ${deadlineAt.toISOString()}`);
  }

  return ok(undefined);
}

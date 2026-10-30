/**
 * Quota and deadline failures cross layer boundaries as values, never as
 * exceptions: running out of budget means "degrade" (skip this source, try the
 * next chain entry), not "fail the run".
 */
export type QuotaErrorCode = 'QUOTA_EXCEEDED' | 'DEADLINE_EXCEEDED' | 'STORAGE_FAILED';

export type QuotaError = { code: QuotaErrorCode; message: string };

/** A failure that crosses a layer boundary without throwing. */
export type Result<T> = { ok: true; value: T } | ({ ok: false } & QuotaError);

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function fail<T>(code: QuotaErrorCode, message: string): Result<T> {
  return { ok: false, code, message };
}

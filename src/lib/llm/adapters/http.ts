import type { AdapterFailure, AdapterFailureReason } from './types';

/** One call may not hang the pipeline; 2 minutes fits a long structured answer. */
export const DEFAULT_TIMEOUT_MS = 120_000;

export type HttpOutcome = { ok: true; body: unknown } | AdapterFailure;

function codeFor(reason: AdapterFailureReason, status: number): string {
  switch (reason) {
    case 'http':
      return String(status);
    case 'timeout':
      return 'timeout';
    case 'network':
      return 'network';
    case 'malformed':
      return 'bad_response';
    case 'empty':
      return 'empty';
  }
}

export function failed(
  reason: AdapterFailureReason,
  status = 0,
  detail?: string,
): AdapterFailure {
  const clean = detail?.replace(/\s+/g, ' ').trim().slice(0, 200);
  return {
    ok: false,
    status,
    reason,
    code: codeFor(reason, status),
    ...(clean === undefined || clean === '' ? {} : { detail: clean }),
  };
}

/**
 * POST JSON and decode the envelope. Error details are intentionally coarse: a
 * provider error body often echoes the prompt, and a network error message may
 * quote the URL (which carries the key for Google), so neither is surfaced.
 */
export async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<HttpOutcome> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const name = (error as { name?: unknown } | null)?.name;
    return name === 'TimeoutError' || name === 'AbortError' ? failed('timeout') : failed('network');
  }

  if (!response.ok) {
    // Read only the provider's own error message: it explains a 400 (model
    // name, schema support, context length) without echoing the prompt.
    let detail: string | undefined;
    try {
      const raw = await response.text();
      try {
        const parsed = JSON.parse(raw) as unknown;
        const record = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
        const error = typeof record['error'] === 'object' && record['error'] !== null ? (record['error'] as Record<string, unknown>) : {};
        const message = typeof error['message'] === 'string' ? error['message'] : typeof record['message'] === 'string' ? record['message'] : '';
        detail = message;
      } catch {
        detail = raw.slice(0, 200);
      }
    } catch {
      detail = undefined;
    }
    return failed('http', response.status, detail);
  }

  let raw: string;
  try {
    raw = await response.text();
  } catch {
    return failed('network');
  }

  try {
    return { ok: true, body: JSON.parse(raw) as unknown };
  } catch {
    return failed('malformed', response.status);
  }
}

/** Drop trailing slashes so a provider base URL and a path never double up. */
export function trimBase(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '');
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Token counters: anything that is not a finite, non-negative number counts as 0. */
export function asCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/** Join the text blocks of a multi-part answer, ignoring non-text parts. */
export function joinText(parts: unknown[]): string {
  return parts
    .map((part) => asString(asRecord(part)?.text))
    .filter((text): text is string => text !== undefined)
    .join('');
}

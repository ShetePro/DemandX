import { createRateLimiter, type RateLimiter } from './limiter';

/**
 * Shared plumbing for adapters: one rate-limited GET, plus defensive decoding
 * helpers for payloads that come from the open web.
 */
export interface SearchDeps {
  /** Injected in tests; production uses the global fetch (Node 22). */
  fetch?: typeof fetch;
  /** Injected to disable throttling in tests or to share state across adapters. */
  limiter?: RateLimiter;
}

/** A hung result page must not stall the pipeline. */
export const SEARCH_TIMEOUT_MS = 15_000;

/**
 * The scraped engines reject requests that do not look like a browser; a
 * missing UA is why an otherwise valid query came back as a dictionary page or
 * a 403. Callers can still override any header through `init.headers`.
 */
const DEFAULT_HEADERS: Readonly<Record<string, string>> = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7',
  Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
};

export class SearchHttpError extends Error {
  constructor(
    readonly url: string,
    readonly status: number,
  ) {
    super(`搜索请求失败：HTTP ${status}`);
    this.name = 'SearchHttpError';
  }
}

let sharedLimiter: RateLimiter | undefined;

function limiterFor(deps: SearchDeps): RateLimiter {
  if (deps.limiter !== undefined) return deps.limiter;
  // Every adapter funnels through the same instance, so two adapters hitting
  // the same host still share one timeline.
  sharedLimiter ??= createRateLimiter();
  return sharedLimiter;
}

/** Rate-limited GET returning the raw body; non-2xx responses throw. */
export async function getText(
  url: string,
  deps: SearchDeps = {},
  init: RequestInit = {},
): Promise<string> {
  await limiterFor(deps).acquire(new URL(url).host);

  const send = deps.fetch ?? fetch;
  const response = await send(url, {
    ...init,
    headers: { ...DEFAULT_HEADERS, ...(init.headers as Record<string, string> | undefined) },
    signal: init.signal ?? AbortSignal.timeout(SEARCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new SearchHttpError(url, response.status);
  return response.text();
}

/** Rate-limited request parsed as JSON; non-2xx responses throw. */
export async function requestJson(
  url: string,
  deps: SearchDeps = {},
  init: RequestInit = {},
): Promise<unknown> {
  await limiterFor(deps).acquire(new URL(url).host);

  const send = deps.fetch ?? fetch;
  const response = await send(url, {
    ...init,
    headers: { ...DEFAULT_HEADERS, ...(init.headers as Record<string, string> | undefined) },
    signal: init.signal ?? AbortSignal.timeout(SEARCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new SearchHttpError(url, response.status);
  return response.json();
}

/** JSON object narrowing for responses typed `unknown`. */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Some feeds encode "one entry" as an object instead of a one-element array. */
export function asList(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Collapse whitespace so markup and JSON escapes never reach evidence text. */
export function cleanText(value: unknown): string {
  const text = asString(value);
  return text === undefined ? '' : text.replace(/\s+/g, ' ').trim();
}

/** First `max` characters of a body, for snippets that must stay one line. */
export function summarize(value: unknown, max = 280): string {
  const text = cleanText(value);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Absolute http(s) URL, or null for `javascript:`, protocol-relative, garbage. */
export function absoluteHttpUrl(value: unknown): string | null {
  const raw = asString(value)?.trim();
  if (raw === undefined || raw === '') return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

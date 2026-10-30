/**
 * One fetched page, reduced to what the pipeline stores and quotes. `text` is
 * the readability output, so every quote the LLM later emits is a substring of
 * a snapshot rather than of the raw markup.
 */
export interface Snapshot {
  url: string;
  html: string;
  text: string;
  title: string;
  /** ISO timestamp from the page's own metadata; absent when it does not say. */
  publishedAt?: string;
}

/** Fetch failures. Only these may be retried. */
export type CrawlErrorCode = 'HTTP_ERROR' | 'TIMEOUT' | 'NOT_HTML' | 'TOO_LARGE';

/**
 * Why a page needs a person. `login` means a persistent browser session could
 * still work; `captcha` and `blocked` are hard stops by policy (no solving, no
 * proxy rotation, no fingerprint spoofing).
 */
export type HumanReason = 'login' | 'captcha' | 'blocked';

/**
 * Closed set so callers branch on `status` and never guess: only `ok` carries
 * content, only `error` is retryable, and `needs_human` must be queued instead.
 */
export type CrawlResult =
  | { status: 'ok'; snapshot: Snapshot }
  | { status: 'needs_human'; reason: HumanReason; url: string }
  | { status: 'error'; code: CrawlErrorCode; url: string };

/** The port every tier implements; the pipeline only depends on this. */
export interface CrawlPort {
  crawl(url: string): Promise<CrawlResult>;
}

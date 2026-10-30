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

/** Why a URL was never fetched. `robots` is a policy skip, not a failure. */
export type SkipReason = 'robots';

/**
 * Closed set so callers branch on `status` and never guess: only `ok` carries
 * content, only `error` is retryable, `needs_human` is queued for a person, and
 * `skipped` is a deliberate non-crawl that must not be retried or queued.
 */
export type CrawlResult =
  | {
      status: 'ok';
      snapshot: Snapshot;
      /**
       * Browser tier only: whether the page had hydrated (`waitForSelector`)
       * before its content was read. `false` means a slow client-side app, not
       * a failure. Absent for the static tier.
       */
      settled?: boolean;
    }
  | { status: 'needs_human'; reason: HumanReason; url: string }
  | { status: 'skipped'; reason: SkipReason; url: string }
  | { status: 'error'; code: CrawlErrorCode; url: string };

/** The port every tier implements; the pipeline only depends on this. */
export interface CrawlPort {
  crawl(url: string): Promise<CrawlResult>;
}

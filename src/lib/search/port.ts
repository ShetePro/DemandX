/**
 * Every platform an evidence hit can come from. Search engines yield `web`;
 * platform-specific adapters tag their own source so downstream evidence keeps
 * the provenance the report must cite.
 */
export type Platform =
  | 'xiaohongshu'
  | 'douyin'
  | 'zhihu'
  | 'twitter'
  | 'v2ex'
  | 'reddit'
  | 'hn'
  | 'appstore'
  | 'github'
  | 'web';

/** Web-search APIs the fallback can talk to. Kept here so client code importing
 * the settings schema does not pull the adapter (and its fetch plumbing) in. */
export const WEB_SEARCH_PROVIDERS = ['tavily', 'brave', 'serper'] as const;

export type WebSearchProvider = (typeof WEB_SEARCH_PROVIDERS)[number];

/** One search result, already normalised to the shape the pipeline consumes. */
export interface SearchHit {
  url: string;
  title: string;
  snippet: string;
  platform: Platform;
  /** ISO timestamp from the source; absent when the source does not say. */
  publishedAt?: string;
}

export interface SearchOptions {
  /** Upper bound on returned hits; adapters also pass it to the source. */
  limit: number;
  /** Only return hits newer than this many days, when the source supports it. */
  recencyDays?: number;
}

/** The port every adapter implements; the pipeline only depends on this. */
export interface SearchPort {
  id: string;
  platform: Platform;
  /**
   * Fallback ports run only after every primary port returned no hit for a
   * query. That is what keeps a keyed web API off the hot path while still
   * covering queries the platform adapters cannot reach.
   */
  fallback?: boolean;
  /**
   * Cap on how many queries of one scan this port serves. Slow or rate-limited
   * platforms (Reddit, GitHub) trade breadth for staying inside their limits.
   */
  maxQueries?: number;
  /**
   * Skip queries this source cannot answer usefully (Reddit has no Chinese
   * corpus worth searching); skipped queries do not spend `maxQueries`.
   */
  supportsQuery?: (query: string) => boolean;
  /**
   * Skip the first N supported queries before serving one. Lets several
   * platforms of the same language search different angles instead of all
   * repeating the first Chinese query.
   */
  queryOffset?: number;
  search(q: string, opts: SearchOptions): Promise<SearchHit[]>;
}

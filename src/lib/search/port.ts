/**
 * Every platform an evidence hit can come from. Search engines yield `web`;
 * platform-specific adapters tag their own source so downstream evidence keeps
 * the provenance the report must cite.
 */
export type Platform =
  'xiaohongshu' | 'douyin' | 'zhihu' | 'v2ex' | 'reddit' | 'hn' | 'appstore' | 'github' | 'web';

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
  search(q: string, opts: SearchOptions): Promise<SearchHit[]>;
}

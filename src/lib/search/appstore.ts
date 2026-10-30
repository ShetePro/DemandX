import {
  absoluteHttpUrl,
  asList,
  asRecord,
  asString,
  cleanText,
  getText,
  summarize,
  type SearchDeps,
} from './http';
import type { SearchHit, SearchPort } from './port';

const ENDPOINT = 'https://itunes.apple.com';

export interface AppStoreSearchOptions extends SearchDeps {
  /** Numeric App Store id, e.g. `284882215`. */
  appId: number | string;
  /** Storefront used both in the URL and in the reviews' language. */
  country?: string;
}

/**
 * The public reviews feed has no full-text query, so `q` only travels with the
 * port signature; the adapter returns the app's most recent reviews.
 */
export function parseAppStoreJson(body: string, limit: number): SearchHit[] {
  let payload: unknown;
  try {
    payload = JSON.parse(body) as unknown;
  } catch {
    return [];
  }

  const feed = asRecord(asRecord(payload)?.feed);
  const hits: SearchHit[] = [];

  for (const entry of asList(feed?.entry)) {
    if (hits.length >= limit) break;

    const review = asRecord(entry);
    if (review === undefined) continue;

    const url = absoluteHttpUrl(asRecord(asRecord(review.link)?.attributes)?.href);
    if (url === null) continue;

    const title = cleanText(asRecord(review.title)?.label);
    if (title === '') continue;

    const publishedAt = asString(asRecord(review.updated)?.label);
    hits.push({
      url,
      title,
      snippet: summarize(asRecord(review.content)?.label),
      platform: 'appstore',
      ...(publishedAt === undefined ? {} : { publishedAt }),
    });
  }

  return hits;
}

export function createAppStoreSearch({
  appId,
  country = 'us',
  ...deps
}: AppStoreSearchOptions): SearchPort {
  const id = String(appId).trim();
  if (id === '') throw new Error('AppStore search 需要 appId');

  const endpoint = `${ENDPOINT}/${encodeURIComponent(country)}/rss/customerreviews/page=1/id=${encodeURIComponent(
    id,
  )}/sortby=mostrecent/json`;

  return {
    id: `appstore-${id}`,
    platform: 'appstore',
    async search(_q, opts) {
      return parseAppStoreJson(await getText(endpoint, deps), opts.limit);
    },
  };
}

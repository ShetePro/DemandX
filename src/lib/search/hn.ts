import {
  absoluteHttpUrl,
  asArray,
  asRecord,
  asString,
  cleanText,
  getText,
  summarize,
  type SearchDeps,
} from './http';
import type { SearchHit, SearchPort } from './port';

const ENDPOINT = 'https://hn.algolia.com/api/v1/search';
const ITEM_URL = 'https://news.ycombinator.com/item?id=';

/**
 * Algolia already returns structured stories. A story without an external URL
 * (Ask HN, text posts) still has a discussion page worth collecting.
 */
export function parseHnJson(body: string, limit: number): SearchHit[] {
  let payload: unknown;
  try {
    payload = JSON.parse(body) as unknown;
  } catch {
    return [];
  }

  const hits: SearchHit[] = [];
  for (const entry of asArray(asRecord(payload)?.hits)) {
    if (hits.length >= limit) break;

    const hit = asRecord(entry);
    if (hit === undefined) continue;

    const title = cleanText(hit.title);
    if (title === '') continue;

    const objectID = asString(hit.objectID);
    const url =
      absoluteHttpUrl(hit.url) ??
      (objectID === undefined || objectID === ''
        ? null
        : `${ITEM_URL}${encodeURIComponent(objectID)}`);
    if (url === null) continue;

    const publishedAt = asString(hit.created_at);
    hits.push({
      url,
      title,
      snippet: summarize(hit.story_text),
      platform: 'hn',
      ...(publishedAt === undefined ? {} : { publishedAt }),
    });
  }

  return hits;
}

export function createHnSearch(deps: SearchDeps = {}): SearchPort {
  return {
    id: 'hn',
    platform: 'hn',
    async search(q, opts) {
      const url = new URL(ENDPOINT);
      url.searchParams.set('query', q);
      url.searchParams.set('tags', 'story');
      url.searchParams.set('hitsPerPage', String(opts.limit));
      return parseHnJson(await getText(url.toString(), deps), opts.limit);
    },
  };
}

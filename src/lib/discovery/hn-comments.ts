import { load } from 'cheerio';

import {
  asArray,
  asRecord,
  asString,
  cleanText,
  requestJson,
  type SearchDeps,
} from '@/lib/search/http';
import type { SearchHit, SearchPort } from '@/lib/search/port';

const ENDPOINT = 'https://hn.algolia.com/api/v1/search';
const ITEM_URL = 'https://news.ycombinator.com/item?id=';

/**
 * Discovery needs complaints, not product launches: the story index returns
 * Show HN and pricing pages, while the comment index returns people describing
 * the workaround they hate. Each hit links to its discussion item.
 */
export function parseHnComments(payload: unknown, limit: number): SearchHit[] {
  const hits: SearchHit[] = [];

  for (const entry of asArray(asRecord(payload)?.['hits'])) {
    if (hits.length >= limit) break;

    const hit = asRecord(entry);
    if (hit === undefined) continue;

    // Algolia returns HTML snippets (`<p>`, links); the model needs text only.
    const raw = asString(hit['comment_text']) ?? '';
    const body = cleanText(load(raw).text());
    if (body === '') continue;

    const storyTitle = cleanText(hit['story_title']);
    const objectID = asString(hit['objectID']);
    if (objectID === undefined || objectID === '') continue;

    const result: SearchHit = {
      url: `${ITEM_URL}${encodeURIComponent(objectID)}`,
      title: storyTitle === '' ? 'HN 讨论' : `${storyTitle} · 评论`,
      snippet: body.slice(0, 300),
      platform: 'hn',
    };
    const createdAt = asString(hit['created_at']);
    if (createdAt !== undefined && createdAt !== '') result.publishedAt = createdAt;
    hits.push(result);
  }

  return hits;
}

export function createHnCommentSearch(deps: SearchDeps = {}): SearchPort {
  return {
    id: 'hn-comments',
    platform: 'hn',
    async search(q, opts) {
      const url = new URL(ENDPOINT);
      url.searchParams.set('query', q);
      url.searchParams.set('tags', 'comment');
      url.searchParams.set('hitsPerPage', String(opts.limit));
      return parseHnComments(await requestJson(url.toString(), deps), opts.limit);
    },
  };
}

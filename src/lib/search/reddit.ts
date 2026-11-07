import { load } from 'cheerio';

import { absoluteHttpUrl, cleanText, getText, summarize, type SearchDeps } from './http';
import { createRateLimiter } from './limiter';
import type { SearchHit, SearchPort } from './port';

const ENDPOINT = 'https://www.reddit.com/search.rss';

/**
 * Reddit refuses the anonymous JSON API from most IPs (403) and rate-limits
 * aggressively, but the Atom search feed stays readable. The adapter walks it
 * with its own slow limiter and only for a few queries per scan.
 */
const REDDIT_HEADERS = {
  Accept: 'application/atom+xml',
};

/** Reddit 429s anonymous RSS within seconds; pace requests well apart. */
const REDDIT_LIMITER = createRateLimiter({ rps: 0.2, minDelayMs: 5_000, maxDelayMs: 7_000 });

/** Searches per scan: enough for real complaints without burning the budget. */
export const REDDIT_QUERIES_PER_SCAN = 2;

function entrySnippet(content: string): string {
  if (content.trim() === '') return '';
  // The feed embeds escaped HTML; strip tags before the model sees it.
  return summarize(load(content).text(), 300);
}

/** Atom feed -> hits; malformed entries are skipped rather than thrown. */
export function parseRedditRss(xml: string, limit: number): SearchHit[] {
  if (xml.trim() === '') return [];

  const $ = load(xml, { xmlMode: true });
  const hits: SearchHit[] = [];

  for (const entry of $('entry').toArray()) {
    if (hits.length >= limit) break;

    const node = $(entry);
    const title = cleanText(node.find('title').first().text());
    const url = absoluteHttpUrl(node.find('link').first().attr('href'));
    if (title === '' || url === null) continue;

    const updated = cleanText(node.find('updated').first().text());
    const hit: SearchHit = {
      url,
      title,
      snippet: entrySnippet(node.find('content').first().text()),
      platform: 'reddit',
    };
    if (updated !== '') hit.publishedAt = updated;
    hits.push(hit);
  }

  return hits;
}

export function createRedditSearch(deps: SearchDeps = {}): SearchPort {
  return {
    id: 'reddit',
    platform: 'reddit',
    maxQueries: REDDIT_QUERIES_PER_SCAN,
    // Chinese queries return dictionary pages or nothing; spend the slow
    // budget only on English demand threads.
    supportsQuery: (query) => /[a-z]{4}/i.test(query) && !/[\u4e00-\u9fff]/.test(query),
    async search(q, opts) {
      const url = new URL(ENDPOINT);
      url.searchParams.set('q', q);
      // Relevance within the last year: recent enough to be current demand,
      // ranked so the thread is actually about the query.
      url.searchParams.set('sort', 'relevance');
      url.searchParams.set('t', 'year');
      url.searchParams.set('limit', String(opts.limit));

      const xml = await getText(
        url.toString(),
        { ...deps, limiter: REDDIT_LIMITER },
        { headers: REDDIT_HEADERS },
      );
      return parseRedditRss(xml, opts.limit);
    },
  };
}

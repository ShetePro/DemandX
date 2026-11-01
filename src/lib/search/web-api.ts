import { asRecord, requestJson, type SearchDeps } from './http';
import type { SearchHit, SearchPort, WebSearchProvider } from './port';

/**
 * API-backed web search, used when a platform session is unavailable and the
 * scraped engines (DDG/Bing) are blocked or rate-limited. Unlike the scrapers
 * this needs a key, so the worker only registers the port when one is
 * configured; the pipeline then treats it as a fallback, not a primary source.
 */
export type { WebSearchProvider } from './port';

export type WebSearchConfig = {
  provider: WebSearchProvider;
  apiKey: string;
  /** Overrides the provider's public endpoint (tests, proxies). */
  baseUrl?: string;
};

const ENDPOINTS: Readonly<Record<WebSearchProvider, string>> = {
  tavily: 'https://api.tavily.com/search',
  brave: 'https://api.search.brave.com/res/v1/web/search',
  serper: 'https://google.serper.dev/search',
};

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === 'string' ? value.trim() : '';
}

function resultsOf(payload: unknown, key: string): Record<string, unknown>[] {
  const root = asRecord(payload);
  if (root === undefined) return [];

  const value = root[key];
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const record = asRecord(item);
    return record === undefined ? [] : [record];
  });
}

/** Tavily: `results[] { title, url, content, published_date? }`. */
export function parseTavily(payload: unknown, limit: number): SearchHit[] {
  return parseList(resultsOf(payload, 'results'), limit, {
    url: 'url',
    title: 'title',
    snippet: 'content',
    publishedAt: 'published_date',
  });
}

/** Brave: `web.results[] { title, url, description, age? }`. */
export function parseBrave(payload: unknown, limit: number): SearchHit[] {
  const root = asRecord(payload);
  const web = asRecord(root?.['web']);
  const results = web?.['results'];
  const list = Array.isArray(results) ? results : [];
  return parseList(
    list.flatMap((item) => {
      const record = asRecord(item);
      return record === undefined ? [] : [record];
    }),
    limit,
    { url: 'url', title: 'title', snippet: 'description', publishedAt: 'age' },
  );
}

/** Serper: `organic[] { title, link, snippet, date? }`. */
export function parseSerper(payload: unknown, limit: number): SearchHit[] {
  return parseList(resultsOf(payload, 'organic'), limit, {
    url: 'link',
    title: 'title',
    snippet: 'snippet',
    publishedAt: 'date',
  });
}

function parseList(
  items: readonly Record<string, unknown>[],
  limit: number,
  fields: { url: string; title: string; snippet: string; publishedAt: string },
): SearchHit[] {
  const hits: SearchHit[] = [];
  for (const item of items) {
    if (hits.length >= limit) break;

    const url = stringField(item, fields.url);
    const title = stringField(item, fields.title);
    if (!/^https?:\/\//i.test(url) || title === '') continue;

    const hit: SearchHit = {
      url,
      title,
      snippet: stringField(item, fields.snippet),
      platform: 'web',
    };
    const publishedAt = stringField(item, fields.publishedAt);
    if (publishedAt !== '') hit.publishedAt = publishedAt;
    hits.push(hit);
  }
  return hits;
}

function parse(provider: WebSearchProvider, payload: unknown, limit: number): SearchHit[] {
  switch (provider) {
    case 'tavily':
      return parseTavily(payload, limit);
    case 'brave':
      return parseBrave(payload, limit);
    case 'serper':
      return parseSerper(payload, limit);
  }
}

export function createWebApiSearch(config: WebSearchConfig, deps: SearchDeps = {}): SearchPort {
  const endpoint = config.baseUrl?.trim() || ENDPOINTS[config.provider];

  return {
    id: `web-api-${config.provider}`,
    platform: 'web',
    // Only consulted when every primary adapter came back empty.
    fallback: true,
    async search(q, opts) {
      const limit = Math.max(1, Math.min(opts.limit, 20));
      const payload =
        config.provider === 'brave'
          ? await searchBrave(endpoint, config.apiKey, q, limit, deps)
          : await searchPost(endpoint, config.provider, config.apiKey, q, limit, deps);
      return parse(config.provider, payload, limit);
    },
  };
}

async function searchBrave(
  endpoint: string,
  apiKey: string,
  q: string,
  limit: number,
  deps: SearchDeps,
): Promise<unknown> {
  const url = new URL(endpoint);
  url.searchParams.set('q', q);
  url.searchParams.set('count', String(limit));

  return requestJson(url.toString(), deps, {
    headers: { Accept: 'application/json', 'X-Subscription-Token': apiKey },
  });
}

async function searchPost(
  endpoint: string,
  provider: 'tavily' | 'serper',
  apiKey: string,
  q: string,
  limit: number,
  deps: SearchDeps,
): Promise<unknown> {
  const body =
    provider === 'tavily'
      ? { api_key: apiKey, query: q, max_results: limit, search_depth: 'basic' }
      : { q, num: limit };

  return requestJson(endpoint, deps, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(provider === 'tavily' ? {} : { 'X-API-KEY': apiKey }),
    },
    body: JSON.stringify(body),
  });
}

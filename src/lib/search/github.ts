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

const ENDPOINT = 'https://api.github.com/search/issues';
/** Anonymous search stays usable only with an explicit UA; GitHub rejects none. */
const HEADERS = {
  accept: 'application/vnd.github+json',
  'user-agent': 'DemandX',
};

/** Issue search doubles as a demand signal: titles and bodies state the ask. */
export function parseGitHubJson(body: string, limit: number): SearchHit[] {
  let payload: unknown;
  try {
    payload = JSON.parse(body) as unknown;
  } catch {
    return [];
  }

  const hits: SearchHit[] = [];
  for (const entry of asArray(asRecord(payload)?.items)) {
    if (hits.length >= limit) break;

    const item = asRecord(entry);
    if (item === undefined) continue;

    const url = absoluteHttpUrl(item.html_url);
    if (url === null) continue;

    const title = cleanText(item.title);
    if (title === '') continue;

    const publishedAt = asString(item.created_at);
    hits.push({
      url,
      title,
      snippet: summarize(item.body),
      platform: 'github',
      ...(publishedAt === undefined ? {} : { publishedAt }),
    });
  }

  return hits;
}

export function createGitHubSearch(deps: SearchDeps = {}): SearchPort {
  return {
    id: 'github',
    platform: 'github',
    async search(q, opts) {
      const url = new URL(ENDPOINT);
      url.searchParams.set('q', `${q} is:issue`);
      url.searchParams.set('per_page', String(opts.limit));
      return parseGitHubJson(await getText(url.toString(), deps, { headers: HEADERS }), opts.limit);
    },
  };
}

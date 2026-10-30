import { load } from 'cheerio';

import { absoluteHttpUrl, cleanText, getText, type SearchDeps } from './http';
import type { SearchHit, SearchPort } from './port';

const ENDPOINT = 'https://html.duckduckgo.com/html/';

/**
 * DDG wraps results in `/l/?uddg=<encoded target>` and serves ads as
 * `duckduckgo.com/y.js`. Everything else on that host is navigation chrome.
 */
function resolveDdgHref(href: string | undefined): string | null {
  const raw = href?.trim();
  if (raw === undefined || raw === '') return null;

  let url: URL;
  try {
    url = new URL(raw, ENDPOINT);
  } catch {
    return null;
  }

  if (url.hostname === 'duckduckgo.com' || url.hostname.endsWith('.duckduckgo.com')) {
    if (url.pathname === '/y.js') return null;
    if (url.pathname !== '/l/') return null;
    return absoluteHttpUrl(url.searchParams.get('uddg'));
  }
  return absoluteHttpUrl(url.href);
}

/** Empty or unrecognised markup yields `[]`; parsing never throws. */
export function parseDuckDuckGoHtml(html: string, limit: number): SearchHit[] {
  const $ = load(html);
  const hits: SearchHit[] = [];

  for (const anchor of $('a.result__a').toArray()) {
    if (hits.length >= limit) break;

    const link = $(anchor);
    const url = resolveDdgHref(link.attr('href'));
    if (url === null) continue;

    const title = cleanText(link.text());
    if (title === '') continue;

    const snippet = cleanText(link.closest('.result').find('.result__snippet').first().text());
    hits.push({ url, title, snippet, platform: 'web' });
  }

  return hits;
}

export function createDuckDuckGoSearch(deps: SearchDeps = {}): SearchPort {
  return {
    id: 'ddg',
    platform: 'web',
    async search(q, opts) {
      const url = new URL(ENDPOINT);
      url.searchParams.set('q', q);
      // DDG's nearest range is `d` (past day); wider ranges have no mapping yet.
      if (opts.recencyDays !== undefined && opts.recencyDays <= 1) {
        url.searchParams.set('df', 'd');
      }
      return parseDuckDuckGoHtml(await getText(url.toString(), deps), opts.limit);
    },
  };
}

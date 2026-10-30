import { load } from 'cheerio';

import { absoluteHttpUrl, cleanText, getText, type SearchDeps } from './http';
import type { SearchHit, SearchPort } from './port';

const ENDPOINT = 'https://www.bing.com/search';

/**
 * Bing ships result links through `/ck/a?u=a1<base64url>` click tracking, so a
 * raw `href` would send every hit to bing.com. Direct hrefs are kept as-is.
 */
function resolveBingHref(href: string | undefined): string | null {
  const raw = href?.trim();
  if (raw === undefined || raw === '') return null;

  let url: URL;
  try {
    url = new URL(raw, ENDPOINT);
  } catch {
    return null;
  }

  if (url.hostname.endsWith('bing.com') && url.pathname === '/ck/a') {
    const encoded = url.searchParams.get('u');
    if (encoded === null) return null;
    const payload = encoded.startsWith('a1') ? encoded.slice(2) : encoded;
    return absoluteHttpUrl(Buffer.from(payload, 'base64url').toString('utf8'));
  }

  return absoluteHttpUrl(url.href);
}

/** Empty or unrecognised markup yields `[]`; parsing never throws. */
export function parseBingHtml(html: string, limit: number): SearchHit[] {
  const $ = load(html);
  const hits: SearchHit[] = [];

  for (const item of $('li.b_algo').toArray()) {
    if (hits.length >= limit) break;

    const block = $(item);
    const anchor = block.find('h2 a').first();
    const url = resolveBingHref(anchor.attr('href'));
    if (url === null) continue;

    const title = cleanText(anchor.text());
    if (title === '') continue;

    const snippet = cleanText(block.find('.b_caption p').first().text());
    hits.push({ url, title, snippet, platform: 'web' });
  }

  return hits;
}

export function createBingSearch(deps: SearchDeps = {}): SearchPort {
  return {
    id: 'bing',
    platform: 'web',
    async search(q, opts) {
      const url = new URL(ENDPOINT);
      url.searchParams.set('q', q);
      return parseBingHtml(await getText(url.toString(), deps), opts.limit);
    },
  };
}

/**
 * Tracking parameters are noise for dedupe: they change per campaign while the
 * page content stays the same. Everything else in the query string is
 * business data and is preserved.
 */
const TRACKING_PARAMS: Readonly<Record<string, true>> = {
  fbclid: true,
  gclid: true,
  yclid: true,
  mc_cid: true,
  mc_eid: true,
};
const TRACKING_PREFIX = 'utm_';

interface QueryPart {
  /** Decoded, lowercased key — only used for filtering and ordering. */
  key: string;
  /** Original `key=value` segment, kept verbatim so encoding survives. */
  raw: string;
}

function decodeKey(rawKey: string): string {
  try {
    return decodeURIComponent(rawKey.replace(/\+/g, ' ')).toLowerCase();
  } catch {
    return rawKey.toLowerCase();
  }
}

function isTrackingParam(key: string): boolean {
  return key.startsWith(TRACKING_PREFIX) || TRACKING_PARAMS[key] === true;
}

/**
 * Drop the leading `?`, filter tracking params, and sort the rest by key
 * ascending. `Array#sort` is stable, so repeated keys keep their original
 * relative order.
 */
function canonicalQuery(search: string): string {
  const parts = search.replace(/^\?/, '').split('&');
  const kept: QueryPart[] = [];

  for (const raw of parts) {
    if (raw.length === 0) continue;
    const separator = raw.indexOf('=');
    const rawKey = separator === -1 ? raw : raw.slice(0, separator);
    const key = decodeKey(rawKey);
    if (isTrackingParam(key)) continue;
    kept.push({ key, raw });
  }

  kept.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return kept.length === 0 ? '' : `?${kept.map((part) => part.raw).join('&')}`;
}

/** `/a/` → `/a`, `/a//` → `/a`, but the root stays `/`. */
function trimTrailingSlashes(pathname: string): string {
  let end = pathname.length;
  while (end > 1 && pathname[end - 1] === '/') end -= 1;
  return pathname.slice(0, end);
}

/**
 * Canonical form used as the dedupe key of `sources.canonical_url`.
 *
 * Lowercases scheme and host, drops default ports (the URL parser already
 * removes `:80` for http and `:443` for https), the fragment, and tracking
 * params; sorts the remaining query by key; and strips trailing path slashes.
 * The path itself is case-sensitive, and `www.` is never removed — both would
 * merge distinct resources.
 *
 * @returns the canonical URL, or `null` when the input is not an absolute
 * http(s) URL.
 */
export function canonicalizeUrl(raw: string): string | null {
  if (typeof raw !== 'string' || raw.trim().length === 0) return null;

  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.hostname.length === 0) return null;

  const pathname = trimTrailingSlashes(url.pathname);
  return `${url.protocol}//${url.host}${pathname}${canonicalQuery(url.search)}`;
}

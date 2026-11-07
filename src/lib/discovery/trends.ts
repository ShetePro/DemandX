import {
  absoluteHttpUrl,
  asArray,
  asRecord,
  asString,
  cleanText,
  requestJson,
  summarize,
  type SearchDeps,
} from '@/lib/search/http';

import type { TrendItem } from './types';

const ENDPOINT = 'https://hn.algolia.com/api/v1/search_by_date';
const ITEM_URL = 'https://news.ycombinator.com/item?id=';

/** How far back a "recent" trend may be; older stories are already priced in. */
export const TREND_WINDOW_DAYS = 14;
/** Enough points that the story actually trended, not merely got posted. */
export const TREND_MIN_POINTS = 40;
export const TREND_LIMIT = 20;

export type TrendOutcome =
  { ok: true; value: TrendItem[] } | { ok: false; message: string };

/**
 * HN stories ranked by date rather than relevance: the planner needs what the
 * scene is talking about *this fortnight*, not the all-time classics. Link
 * posts have no body, so the title alone is the snippet.
 */
export function parseHnTrends(payload: unknown, limit = TREND_LIMIT): TrendItem[] {
  const items: TrendItem[] = [];

  for (const entry of asArray(asRecord(payload)?.['hits'])) {
    if (items.length >= limit) break;

    const hit = asRecord(entry);
    if (hit === undefined) continue;

    const title = cleanText(hit['title']) || cleanText(hit['story_title']);
    if (title === '') continue;

    const objectID = asString(hit['objectID']);
    const url =
      absoluteHttpUrl(hit['url']) ??
      (objectID === undefined || objectID === ''
        ? null
        : `${ITEM_URL}${encodeURIComponent(objectID)}`);
    if (url === null) continue;

    const points = Number(hit['points']);
    const createdAt = asString(hit['created_at']);
    const body = summarize(hit['story_text'] ?? hit['comment_text'], 220);

    items.push({
      title,
      url,
      snippet: body,
      points: Number.isFinite(points) ? points : null,
      platform: 'hn',
      ...(createdAt === undefined || createdAt === '' ? {} : { publishedAt: createdAt }),
    });
  }

  return items;
}

/**
 * Recent high-signal headlines for the planner. A blocked or timed-out HN must
 * not fail the scan: the caller gets `ok: false` and plans without trends.
 */
export async function fetchTrends(
  options: {
    now?: Date;
    limit?: number;
    windowDays?: number;
    minPoints?: number;
    deps?: SearchDeps;
  } = {},
): Promise<TrendOutcome> {
  const now = options.now ?? new Date();
  const since = Math.floor(now.getTime() / 1000) - (options.windowDays ?? TREND_WINDOW_DAYS) * 86_400;

  const url = new URL(ENDPOINT);
  url.searchParams.set('tags', 'story');
  url.searchParams.set(
    'numericFilters',
    `created_at_i>${since},points>${options.minPoints ?? TREND_MIN_POINTS}`,
  );
  url.searchParams.set('hitsPerPage', String(options.limit ?? TREND_LIMIT));

  try {
    const payload = await requestJson(url.toString(), options.deps ?? {});
    return { ok: true, value: parseHnTrends(payload, options.limit ?? TREND_LIMIT) };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : '热点检索失败',
    };
  }
}

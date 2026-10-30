import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { parseHnJson } from './hn';

const fixture = readFileSync(
  new URL('../../../tests/fixtures/search/hn.json', import.meta.url),
  'utf8',
);

describe('parseHnJson', () => {
  it('maps Algolia stories to hits with their publish time', () => {
    const hits = parseHnJson(fixture, 5);

    expect(hits).toHaveLength(5);
    expect(hits[0]).toEqual({
      url: 'https://forum.cursor.com/t/usage-page-to-token-amount-what/167153',
      title: 'Cursor removed cost information from the usage page and CSV export',
      snippet: '',
      platform: 'hn',
      publishedAt: '2026-08-01T15:25:21Z',
    });
    expect(hits.every((hit) => hit.platform === 'hn')).toBe(true);
  });

  it('falls back to the item page when a story has no url', () => {
    const hits = parseHnJson(fixture, 5);
    const askHn = hits.find(
      (hit) => hit.title === 'Ask HN: Tools to call REST API and export to CSV?',
    );

    expect(askHn?.url).toBe('https://news.ycombinator.com/item?id=22988077');
    // Text posts describe the ask in their body, so the snippet is not empty.
    expect(askHn?.snippet).toContain('REST API');
    expect(parseHnJson('{"hits":[]}', 5)).toEqual([]);
    expect(parseHnJson('not json', 5)).toEqual([]);
  });
});

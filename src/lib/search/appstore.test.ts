import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { parseAppStoreJson } from './appstore';

const fixture = readFileSync(
  new URL('../../../tests/fixtures/search/appstore.json', import.meta.url),
  'utf8',
);

describe('parseAppStoreJson', () => {
  it('maps review entries to hits with their review text', () => {
    const hits = parseAppStoreJson(fixture, 3);

    expect(hits).toHaveLength(3);
    expect(hits[0]).toMatchObject({
      platform: 'appstore',
      publishedAt: '2026-10-28T06:48:02-07:00',
    });
    expect(hits[0]?.url).toContain('https://itunes.apple.com/us/review?id=284882215');
    expect(hits[0]?.url).toContain('dx_review=');
    expect(new Set(hits.map((hit) => hit.url)).size).toBe(3);
    expect(hits[0]?.title).toContain('Ads');
    expect(hits[0]?.snippet).toContain('Sifting');
    expect(hits.every((hit) => hit.platform === 'appstore')).toBe(true);
  });

  it('accepts a single entry object and returns [] when the feed has none', () => {
    const single = parseAppStoreJson(
      JSON.stringify({
        feed: {
          entry: {
            title: { label: 'Works well' },
            content: { label: 'Does what I need.' },
            link: { attributes: { href: 'https://apps.apple.com/us/review?id=1' } },
            updated: { label: '2026-01-01T00:00:00Z' },
          },
        },
      }),
      5,
    );

    expect(single).toEqual([
      {
        url: 'https://apps.apple.com/us/review?id=1&dx_review=1',
        title: 'Works well',
        snippet: 'Does what I need.',
        platform: 'appstore',
        publishedAt: '2026-01-01T00:00:00Z',
      },
    ]);
    expect(parseAppStoreJson('{"feed":{}}', 5)).toEqual([]);
    expect(parseAppStoreJson('not json', 5)).toEqual([]);
  });
});

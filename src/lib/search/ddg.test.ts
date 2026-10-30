import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { parseDuckDuckGoHtml } from './ddg';

const fixture = readFileSync(
  new URL('../../../tests/fixtures/search/ddg.html', import.meta.url),
  'utf8',
);

describe('parseDuckDuckGoHtml', () => {
  it('parses organic results and unwraps the uddg redirect', () => {
    const hits = parseDuckDuckGoHtml(fixture, 10);

    expect(hits).toHaveLength(3);
    expect(hits[0]).toMatchObject({
      url: 'https://community.example.com/t/csv-export-annoying/123',
      platform: 'web',
    });
    expect(hits[0]?.title).toContain('CSV export');
    expect(hits[0]?.snippet).toContain('CSV');
    // Query strings survive the decode instead of being flattened into the path.
    expect(hits[2]?.url).toBe('https://forum.example.net/threads/export-to-excel?p=42');
    expect(hits.map((hit) => hit.platform)).toEqual(['web', 'web', 'web']);
  });

  it('skips sponsored y.js links, honours the limit, and tolerates empty markup', () => {
    const limited = parseDuckDuckGoHtml(fixture, 2);
    expect(limited).toHaveLength(2);
    expect(limited.map((hit) => hit.title)).not.toContain(
      'Sponsored: Export anything in one click',
    );

    const full = parseDuckDuckGoHtml(fixture, 10);
    expect(full.some((hit) => hit.url.includes('y.js'))).toBe(false);
    expect(parseDuckDuckGoHtml('<html><body></body></html>', 10)).toEqual([]);
  });
});

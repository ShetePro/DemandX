import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { parseBingHtml } from './bing';

const fixture = readFileSync(
  new URL('../../../tests/fixtures/search/bing.html', import.meta.url),
  'utf8',
);

describe('parseBingHtml', () => {
  it('parses b_algo results and decodes the ck/a click wrapper', () => {
    const hits = parseBingHtml(fixture, 3);

    expect(hits).toHaveLength(3);
    expect(hits.every((hit) => hit.platform === 'web')).toBe(true);
    expect(hits.every((hit) => hit.title.length > 0)).toBe(true);
    expect(hits.every((hit) => hit.snippet.length > 0)).toBe(true);

    const [first] = hits;
    expect(first?.url).toBeTruthy();
    expect(first === undefined ? '' : new URL(first.url).hostname).toBe('dictionary.cambridge.org');
    expect(hits.some((hit) => hit.url.includes('bing.com/ck/a'))).toBe(false);
  });

  it('skips blocks without a usable link and returns [] for empty markup', () => {
    const direct = parseBingHtml(
      '<html><body><li class="b_algo"><h2><a href="https://example.com/a">A result</a></h2>' +
        '<div class="b_caption"><p>A snippet</p></div></li></body></html>',
      5,
    );
    expect(direct).toEqual([
      { url: 'https://example.com/a', title: 'A result', snippet: 'A snippet', platform: 'web' },
    ]);

    const linkless = '<li class="b_algo"><div class="b_caption"><p>No title link</p></div></li>';
    expect(parseBingHtml(linkless, 5)).toEqual([]);
    expect(parseBingHtml('', 5)).toEqual([]);
  });
});

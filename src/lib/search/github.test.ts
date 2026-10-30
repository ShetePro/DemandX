import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { parseGitHubJson } from './github';

const fixture = readFileSync(
  new URL('../../../tests/fixtures/search/github.json', import.meta.url),
  'utf8',
);

describe('parseGitHubJson', () => {
  it('maps issue search items to hits with created_at', () => {
    const hits = parseGitHubJson(fixture, 5);

    expect(hits).toHaveLength(5);
    expect(hits[0]).toMatchObject({
      url: 'https://github.com/rainbows4dinos/Seeen/issues/11',
      title: 'CSV export',
      platform: 'github',
      publishedAt: '2026-10-29T02:28:38Z',
    });
    expect(hits[0]?.snippet).toContain('Outcome');
    expect(hits.every((hit) => hit.platform === 'github')).toBe(true);
  });

  it('returns [] for no items, malformed payloads, and items without a link', () => {
    expect(parseGitHubJson('{"total_count":0,"items":[]}', 5)).toEqual([]);
    expect(parseGitHubJson('{}', 5)).toEqual([]);
    expect(parseGitHubJson('not json', 5)).toEqual([]);
    expect(
      parseGitHubJson('{"items":[{"title":"no link"},{"html_url":"https://x.test/1"}]}', 5),
    ).toEqual([]);
  });
});

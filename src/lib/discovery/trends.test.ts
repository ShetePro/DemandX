import { describe, expect, it, vi } from 'vitest';

import { fetchTrends, parseHnTrends, TREND_LIMIT } from './trends';

const PAYLOAD = {
  hits: [
    {
      title: 'Show HN: I replaced my invoicing workflow',
      url: 'https://example.com/a',
      objectID: '1',
      points: 120,
      created_at: '2026-10-30T10:00:00.000Z',
      story_text: '<p>Small studios still chase invoices by hand.</p>',
    },
    {
      title: 'Ask HN: scheduling tools for tiny clinics?',
      url: null,
      objectID: '2',
      points: 64,
      created_at: '2026-10-31T10:00:00.000Z',
      story_text: 'We run three rooms and still use a spreadsheet.',
    },
    { title: '', objectID: '3', points: 90 },
    { title: 'No object id', url: 'https://example.com/b', points: 50 },
  ],
};

describe('parseHnTrends', () => {
  it('keeps recent stories with a usable URL, including Ask HN item links', () => {
    const trends = parseHnTrends(PAYLOAD);

    expect(trends).toHaveLength(3);
    expect(trends[0]).toMatchObject({
      title: 'Show HN: I replaced my invoicing workflow',
      url: 'https://example.com/a',
      points: 120,
      platform: 'hn',
    });
    expect(trends[0]?.snippet).toContain('chase invoices');
    expect(trends[1]?.url).toBe('https://news.ycombinator.com/item?id=2');
    expect(trends[2]?.url).toBe('https://example.com/b');
  });

  it('caps the number of trends', () => {
    const many = {
      hits: Array.from({ length: 30 }, (_, index) => ({
        title: `Story ${index}`,
        url: `https://example.com/${index}`,
        objectID: String(index),
        points: 50,
      })),
    };
    expect(parseHnTrends(many)).toHaveLength(TREND_LIMIT);
  });
});

describe('fetchTrends', () => {
  it('asks Algolia for stories from the last window, sorted by date', async () => {
    const fetchMock = vi.fn<(url: RequestInfo | URL) => Promise<Response>>(
      async () => new Response(JSON.stringify(PAYLOAD), { status: 200 }),
    );
    const now = new Date('2026-11-03T00:00:00.000Z');

    const outcome = await fetchTrends({ now, deps: { fetch: fetchMock as unknown as typeof fetch } });
    expect(outcome.ok).toBe(true);

    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.pathname).toBe('/api/v1/search_by_date');
    expect(url.searchParams.get('tags')).toBe('story');
    expect(url.searchParams.get('numericFilters')).toContain('points>40');
    expect(url.searchParams.get('numericFilters')).toContain('created_at_i>');
    expect(url.searchParams.get('numericFilters')).toContain(
      String(Math.floor(now.getTime() / 1000) - 14 * 86_400),
    );
  });

  it('reports a blocked source instead of throwing', async () => {
    const outcome = await fetchTrends({
      deps: {
        fetch: (async () => new Response('nope', { status: 429 })) as unknown as typeof fetch,
      },
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.message).toContain('429');
  });
});

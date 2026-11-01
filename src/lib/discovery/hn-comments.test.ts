import { describe, expect, it, vi } from 'vitest';

import type { RateLimiter } from '@/lib/search/limiter';

import { createHnCommentSearch, parseHnComments } from './hn-comments';

const limiter: RateLimiter = { acquire: async () => undefined };

const PAYLOAD = {
  hits: [
    {
      objectID: '101',
      story_id: 9,
      story_title: 'Ask HN: what do you pay for?',
      comment_text: 'We <p>waste hours</p> reconciling invoices by hand — would pay for a tool.',
      created_at: '2026-09-01T00:00:00Z',
    },
    { objectID: '102', comment_text: '   ' },
    { objectID: '103', story_title: 'No body', comment_text: '' },
  ],
};

describe('parseHnComments', () => {
  it('turns comments into hits linked to their discussion item', () => {
    const [hit] = parseHnComments(PAYLOAD, 5);

    expect(hit).toMatchObject({
      url: 'https://news.ycombinator.com/item?id=101',
      title: 'Ask HN: what do you pay for? · 评论',
      platform: 'hn',
      publishedAt: '2026-09-01T00:00:00Z',
    });
    expect(hit?.snippet).toContain('waste hours');
    expect(hit?.snippet).not.toContain('<p>');
  });

  it('returns [] for a malformed payload', () => {
    expect(parseHnComments(null, 5)).toEqual([]);
    expect(parseHnComments({ hits: 'nope' }, 5)).toEqual([]);
  });
});

describe('createHnCommentSearch', () => {
  it('asks Algolia for comments and honours the limit', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(PAYLOAD)));
    const port = createHnCommentSearch({
      fetch: fetchMock as unknown as typeof fetch,
      limiter,
    });

    const hits = await port.search('invoice reconciliation', { limit: 3 });

    expect(port.id).toBe('hn-comments');
    expect(hits).toHaveLength(1);

    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toContain('tags=comment');
    expect(url).toContain('hitsPerPage=3');
    expect(url).toContain('query=invoice+reconciliation');
  });
});

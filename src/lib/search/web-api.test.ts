import { describe, expect, it, vi } from 'vitest';

import type { RateLimiter } from './limiter';
import {
  createWebApiSearch,
  parseBrave,
  parseSerper,
  parseTavily,
  type WebSearchConfig,
} from './web-api';

const limiter: RateLimiter = { acquire: async () => undefined };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const TAVILY = {
  results: [
    {
      title: '库存同步工具对比',
      url: 'https://example.com/compare',
      content: '三个工具的定价与评价',
      published_date: '2026-10-01',
    },
    { title: '没有链接', content: '应被丢弃' },
  ],
};

const BRAVE = {
  web: {
    results: [
      {
        title: 'Podcast chapter tools',
        url: 'https://example.com/podcast',
        description: 'Users complain about manual chaptering',
        age: '3 days ago',
      },
    ],
  },
};

const SERPER = {
  organic: [
    { title: 'Transcription pricing', link: 'https://example.com/price', snippet: '$19/mo' },
  ],
};

describe('parseTavily', () => {
  it('maps results and drops entries without an http url', () => {
    const hits = parseTavily(TAVILY, 5);
    expect(hits).toEqual([
      {
        url: 'https://example.com/compare',
        title: '库存同步工具对比',
        snippet: '三个工具的定价与评价',
        platform: 'web',
        publishedAt: '2026-10-01',
      },
    ]);
  });

  it('returns [] for an unexpected payload instead of throwing', () => {
    expect(parseTavily({ results: 'nope' }, 5)).toEqual([]);
    expect(parseTavily(null, 5)).toEqual([]);
  });
});

describe('parseBrave / parseSerper', () => {
  it('reads the nested web.results array', () => {
    expect(parseBrave(BRAVE, 5)).toEqual([
      {
        url: 'https://example.com/podcast',
        title: 'Podcast chapter tools',
        snippet: 'Users complain about manual chaptering',
        platform: 'web',
        publishedAt: '3 days ago',
      },
    ]);
  });

  it('reads Serper organic results', () => {
    expect(parseSerper(SERPER, 5)).toEqual([
      {
        url: 'https://example.com/price',
        title: 'Transcription pricing',
        snippet: '$19/mo',
        platform: 'web',
      },
    ]);
  });

  it('honours the limit', () => {
    const payload = {
      results: Array.from({ length: 8 }, (_, index) => ({
        title: `t${index}`,
        url: `https://example.com/${index}`,
        content: '',
      })),
    };
    expect(parseTavily(payload, 3)).toHaveLength(3);
  });
});

describe('createWebApiSearch', () => {
  const base: WebSearchConfig = { provider: 'tavily', apiKey: 'sk-test' };

  it('posts the key and query for Tavily', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(TAVILY));
    const port = createWebApiSearch(base, { fetch: fetchMock, limiter });

    const hits = await port.search('库存同步', { limit: 5 });

    expect(port.id).toBe('web-api-tavily');
    expect(port.platform).toBe('web');
    expect(port.fallback).toBe(true);
    expect(hits).toHaveLength(1);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.tavily.com/search');
    expect(init.method).toBe('POST');
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ api_key: 'sk-test', query: '库存同步', max_results: 5 });
  });

  it('sends the Brave key as a header on GET', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(BRAVE));
    const port = createWebApiSearch(
      { provider: 'brave', apiKey: 'brave-key' },
      {
        fetch: fetchMock,
        limiter,
      },
    );

    await port.search('podcast chapters', { limit: 4 });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('q=podcast+chapters');
    expect(url).toContain('count=4');
    expect(init.method).toBeUndefined();
    expect((init.headers as Record<string, string>)['X-Subscription-Token']).toBe('brave-key');
  });

  it('sends Serper the X-API-KEY header and organic count', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(SERPER));
    const port = createWebApiSearch(
      { provider: 'serper', apiKey: 'serper-key' },
      {
        fetch: fetchMock,
        limiter,
      },
    );

    await port.search('定价', { limit: 6 });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://google.serper.dev/search');
    expect((init.headers as Record<string, string>)['X-API-KEY']).toBe('serper-key');
    expect(JSON.parse(String(init.body))).toMatchObject({ q: '定价', num: 6 });
  });

  it('fails loudly on a non-2xx response so S1 can count a skip', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: 'unauthorized' }, 401));
    const port = createWebApiSearch(base, { fetch: fetchMock, limiter });

    await expect(port.search('x', { limit: 3 })).rejects.toThrow('HTTP 401');
  });
});

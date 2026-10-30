import { once } from 'node:events';
import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import { createStaticCrawler } from './static';

const article = readFileSync(
  new URL('../../../tests/fixtures/crawl/article.html', import.meta.url),
  'utf8',
);

const HTML_HEADERS = { 'content-type': 'text/html; charset=utf-8' };

describe('createStaticCrawler', () => {
  it('returns a snapshot for a readable page', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(article, { headers: HTML_HEADERS }),
    ) as unknown as typeof fetch;
    const crawler = createStaticCrawler({ fetchImpl });

    const result = await crawler.crawl('https://example.com/posts/1');

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.snapshot.url).toBe('https://example.com/posts/1');
    expect(result.snapshot.html).toBe(article);
    expect(result.snapshot.title).toContain('小红书笔记采集工具为什么总被封');
    expect(result.snapshot.text).toContain('我用 Node 写了一个小红书笔记采集脚本');
    expect(result.snapshot.text).not.toContain('限时优惠');
  });

  it('maps a non-2xx response to HTTP_ERROR', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('gone', { status: 404, headers: HTML_HEADERS }),
    ) as unknown as typeof fetch;

    await expect(
      createStaticCrawler({ fetchImpl }).crawl('https://example.com/missing'),
    ).resolves.toEqual({ status: 'error', code: 'HTTP_ERROR', url: 'https://example.com/missing' });
  });

  it('maps an aborted fetch to TIMEOUT', async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      // Never resolves on its own: only the crawler's timeout can end it.
      const signal = init?.signal;
      if (signal !== undefined && signal !== null) await once(signal, 'abort');
      const error = new Error('The operation was aborted.');
      error.name = 'AbortError';
      throw error;
    }) as unknown as typeof fetch;

    await expect(
      createStaticCrawler({ fetchImpl, timeoutMs: 20 }).crawl('https://example.com/slow'),
    ).resolves.toEqual({ status: 'error', code: 'TIMEOUT', url: 'https://example.com/slow' });
  });

  it('maps an abort while reading the body to TIMEOUT', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      url: '',
      headers: new Headers({ 'content-type': 'text/html' }),
      body: {
        getReader: () => ({
          read: async () => {
            const error = new Error('The operation was aborted.');
            error.name = 'AbortError';
            throw error;
          },
          cancel: async () => undefined,
          releaseLock: () => undefined,
        }),
      },
      text: async () => '',
    })) as unknown as typeof fetch;

    await expect(
      createStaticCrawler({ fetchImpl }).crawl('https://example.com/stall'),
    ).resolves.toEqual({ status: 'error', code: 'TIMEOUT', url: 'https://example.com/stall' });
  });

  it('maps an unhandled fetch failure to HTTP_ERROR', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;

    await expect(
      createStaticCrawler({ fetchImpl }).crawl('https://example.com/down'),
    ).resolves.toEqual({ status: 'error', code: 'HTTP_ERROR', url: 'https://example.com/down' });
  });

  it('maps a non-HTML content type to NOT_HTML', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response('{"error":"no"}', { headers: { 'content-type': 'application/json' } }),
    ) as unknown as typeof fetch;

    await expect(
      createStaticCrawler({ fetchImpl }).crawl('https://example.com/api'),
    ).resolves.toEqual({ status: 'error', code: 'NOT_HTML', url: 'https://example.com/api' });
  });

  it('maps a body over maxBytes to TOO_LARGE', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(article, { headers: HTML_HEADERS }),
    ) as unknown as typeof fetch;

    await expect(
      createStaticCrawler({ fetchImpl, maxBytes: 256 }).crawl('https://example.com/huge'),
    ).resolves.toEqual({ status: 'error', code: 'TOO_LARGE', url: 'https://example.com/huge' });
  });

  it('rejects on the declared content length before reading the body', async () => {
    const text = vi.fn(async () => article);
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      url: '',
      headers: new Headers({ 'content-type': 'text/html', 'content-length': '9999999' }),
      body: null,
      text,
    })) as unknown as typeof fetch;

    await expect(
      createStaticCrawler({ fetchImpl, maxBytes: 1_000 }).crawl('https://example.com/huge'),
    ).resolves.toEqual({ status: 'error', code: 'TOO_LARGE', url: 'https://example.com/huge' });
    expect(text).not.toHaveBeenCalled();
  });

  it('maps markup without an article to NOT_HTML', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('<html><body><p>空</p></body></html>', { headers: HTML_HEADERS }),
    ) as unknown as typeof fetch;

    await expect(
      createStaticCrawler({ fetchImpl }).crawl('https://example.com/empty'),
    ).resolves.toEqual({ status: 'error', code: 'NOT_HTML', url: 'https://example.com/empty' });
  });

  it('stops at a login wall instead of extracting it', async () => {
    const wall =
      '<html><body><div class="mask"></div><p>请先登录，登录后查看完整内容</p></body></html>';
    const fetchImpl = vi.fn(async () => new Response(wall, { headers: HTML_HEADERS }));
    const fetchDouble = fetchImpl as unknown as typeof fetch;

    await expect(
      createStaticCrawler({ fetchImpl: fetchDouble }).crawl(
        'https://www.xiaohongshu.com/explore/1',
      ),
    ).resolves.toEqual({
      status: 'needs_human',
      reason: 'login',
      url: 'https://www.xiaohongshu.com/explore/1',
    });
  });
});

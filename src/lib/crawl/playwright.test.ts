import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import {
  createPlaywrightCrawler,
  type BrowserContext,
  type BrowserPage,
  type LaunchPersistent,
} from './playwright';

const article = readFileSync(
  new URL('../../../tests/fixtures/crawl/article.html', import.meta.url),
  'utf8',
);

const PAGE_URL = 'https://www.xiaohongshu.com/explore/1';

function harness(
  html: string,
  status = 200,
): {
  launch: LaunchPersistent;
  page: BrowserPage;
  context: BrowserContext;
} {
  const page: BrowserPage = {
    goto: vi.fn(async () => ({ status: () => status })),
    waitForSelector: vi.fn(async () => ({})),
    content: vi.fn(async () => html),
    close: vi.fn(async () => undefined),
  };
  const context: BrowserContext = {
    newPage: vi.fn(async () => page),
    close: vi.fn(async () => undefined),
  };
  const launch = vi.fn(async () => context);
  return { launch, page, context };
}

describe('createPlaywrightCrawler', () => {
  it('opens the persistent profile and waits for DOM content only', async () => {
    const { launch, page } = harness(article);
    const crawler = createPlaywrightCrawler({ profileDir: '/tmp/demandx/profile', launch });

    const result = await crawler.crawl(PAGE_URL);

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.snapshot.url).toBe(PAGE_URL);
    expect(result.snapshot.title).toContain('小红书笔记采集工具为什么总被封');
    expect(result.snapshot.text).toContain('我用 Node 写了一个小红书笔记采集脚本');
    expect(launch).toHaveBeenCalledWith('/tmp/demandx/profile', { headless: false });
    expect(page.goto).toHaveBeenCalledWith(PAGE_URL, {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    });
  });

  it('waits for the hydration marker before reading content', async () => {
    const { launch, page } = harness(article);
    const crawler = createPlaywrightCrawler({ profileDir: '/tmp/demandx/profile', launch });

    const result = await crawler.crawl(PAGE_URL);

    expect(page.waitForSelector).toHaveBeenCalledWith('main, article, [role="main"]', {
      timeout: 8_000,
    });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.settled).toBe(true);
  });

  it('honours a custom selector and settle budget', async () => {
    const { launch, page } = harness(article);
    const crawler = createPlaywrightCrawler({
      profileDir: '/tmp/demandx/profile',
      launch,
      waitForSelector: '#note-content',
      settleTimeoutMs: 1_500,
    });

    await crawler.crawl(PAGE_URL);

    expect(page.waitForSelector).toHaveBeenCalledWith('#note-content', { timeout: 1_500 });
  });

  it('still returns a snapshot when the page never settles', async () => {
    const { launch, page } = harness(article);
    (page.waitForSelector as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      Object.assign(new Error('page.waitForSelector: Timeout 8000ms exceeded.'), {
        name: 'TimeoutError',
      }),
    );
    const crawler = createPlaywrightCrawler({ profileDir: '/tmp/demandx/profile', launch });

    const result = await crawler.crawl(PAGE_URL);

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.settled).toBe(false);
    expect(result.snapshot.text).toContain('我用 Node 写了一个小红书笔记采集脚本');
  });

  it('passes an explicit headless setting through to the launcher', async () => {
    const { launch } = harness(article);
    const crawler = createPlaywrightCrawler({
      profileDir: '/tmp/demandx/profile',
      headless: true,
      launch,
    });

    await crawler.crawl(PAGE_URL);

    expect(launch).toHaveBeenCalledWith('/tmp/demandx/profile', { headless: true });
  });

  it('reuses one context across crawls and closes a page per run', async () => {
    const { launch, page } = harness(article);
    const crawler = createPlaywrightCrawler({ profileDir: '/tmp/demandx/profile', launch });

    await crawler.crawl(PAGE_URL);
    await crawler.crawl(`${PAGE_URL}?second`);

    expect(launch).toHaveBeenCalledTimes(1);
    expect(page.close).toHaveBeenCalledTimes(2);
  });

  it('reports a challenge page instead of its content', async () => {
    const { launch } = harness('<html><body><p>请先登录，登录后查看完整内容</p></body></html>');
    const crawler = createPlaywrightCrawler({ profileDir: '/tmp/demandx/profile', launch });

    await expect(crawler.crawl(PAGE_URL)).resolves.toEqual({
      status: 'needs_human',
      reason: 'login',
      url: PAGE_URL,
    });
  });

  it('maps a timeout from goto to TIMEOUT', async () => {
    const page: BrowserPage = {
      goto: vi.fn(async () => {
        const error = new Error('page.goto: Timeout 30000ms exceeded.');
        error.name = 'TimeoutError';
        throw error;
      }),
      waitForSelector: vi.fn(async () => ({})),
      content: vi.fn(async () => article),
      close: vi.fn(async () => undefined),
    };
    const context: BrowserContext = {
      newPage: vi.fn(async () => page),
      close: vi.fn(async () => undefined),
    };
    const crawler = createPlaywrightCrawler({
      profileDir: '/tmp/demandx/profile',
      launch: vi.fn(async () => context),
    });

    await expect(crawler.crawl(PAGE_URL)).resolves.toEqual({
      status: 'error',
      code: 'TIMEOUT',
      url: PAGE_URL,
    });
    expect(page.close).toHaveBeenCalledTimes(1);
  });

  it('maps an HTTP error status to HTTP_ERROR after ruling out a challenge', async () => {
    const { launch } = harness('<html><body><h1>Not found</h1></body></html>', 404);
    const crawler = createPlaywrightCrawler({ profileDir: '/tmp/demandx/profile', launch });

    await expect(crawler.crawl(PAGE_URL)).resolves.toEqual({
      status: 'error',
      code: 'HTTP_ERROR',
      url: PAGE_URL,
    });
  });

  it('disposes the context and relaunches on the next crawl', async () => {
    const { launch, context } = harness(article);
    const crawler = createPlaywrightCrawler({ profileDir: '/tmp/demandx/profile', launch });

    await crawler.crawl(PAGE_URL);
    await crawler.dispose();

    expect(context.close).toHaveBeenCalledTimes(1);

    await crawler.crawl(PAGE_URL);
    expect(launch).toHaveBeenCalledTimes(2);
  });
});

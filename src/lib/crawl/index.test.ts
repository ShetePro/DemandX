import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import { createCrawler } from './index';
import type { BrowserContext, BrowserPage, LaunchPersistent } from './playwright';
import type { RobotsCache } from './robots';

const article = readFileSync(
  new URL('../../../tests/fixtures/crawl/article.html', import.meta.url),
  'utf8',
);

const PAGE_URL = 'https://www.xiaohongshu.com/explore/1';

const LOGIN_WALL = '<html><body><p>请先登录，登录后查看完整内容</p></body></html>';
const CAPTCHA_WALL = '<html><body><div id="captcha"></div><p>请完成验证</p></body></html>';
const SHELL = '<html><body><div id="root"></div><script>boot()</script></body></html>';

function htmlFetch(html: string, status = 200): typeof fetch {
  return vi.fn(
    async () => new Response(html, { status, headers: { 'content-type': 'text/html' } }),
  ) as unknown as typeof fetch;
}

function browserHarness(html: string): { launch: LaunchPersistent; context: BrowserContext } {
  const page: BrowserPage = {
    goto: vi.fn(async () => ({ status: () => 200 })),
    waitForSelector: vi.fn(async () => ({})),
    content: vi.fn(async () => html),
    close: vi.fn(async () => undefined),
  };
  const context: BrowserContext = {
    newPage: vi.fn(async () => page),
    close: vi.fn(async () => undefined),
  };
  return { launch: vi.fn(async () => context), context };
}

const allowAll: RobotsCache = { canFetch: async () => true };

describe('createCrawler', () => {
  it('runs only the static tier for the static strategy', async () => {
    const fetchImpl = htmlFetch(article);
    const crawler = createCrawler({ strategy: 'static', static: { fetchImpl } });

    const result = await crawler.crawl(PAGE_URL);

    expect(result.status).toBe('ok');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('refuses a browser strategy with no browser options', () => {
    expect(() => createCrawler({ strategy: 'browser' })).toThrow(/browser options/);
  });

  it('skips a URL that robots.txt disallows without fetching or queueing it', async () => {
    const fetchImpl = htmlFetch(article);
    const onRobotsSkip = vi.fn();
    const crawler = createCrawler({
      strategy: 'auto',
      static: { fetchImpl },
      robots: { canFetch: async () => false },
      onRobotsSkip,
    });

    await expect(crawler.crawl(PAGE_URL)).resolves.toEqual({
      status: 'skipped',
      reason: 'robots',
      url: PAGE_URL,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(onRobotsSkip).toHaveBeenCalledWith(PAGE_URL);
  });

  it('escalates a login wall to the browser session', async () => {
    const { launch } = browserHarness(article);
    const crawler = createCrawler({
      strategy: 'auto',
      static: { fetchImpl: htmlFetch(LOGIN_WALL) },
      browser: { profileDir: '/tmp/demandx/profile', launch },
      robots: allowAll,
    });

    const result = await crawler.crawl(PAGE_URL);

    expect(result.status).toBe('ok');
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it('escalates an unextractable page to the browser session', async () => {
    const { launch } = browserHarness(article);
    const crawler = createCrawler({
      strategy: 'auto',
      static: { fetchImpl: htmlFetch(SHELL) },
      browser: { profileDir: '/tmp/demandx/profile', launch },
    });

    await expect(crawler.crawl(PAGE_URL)).resolves.toMatchObject({ status: 'ok' });
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it('does not retry a captcha wall in the browser', async () => {
    const { launch } = browserHarness(article);
    const crawler = createCrawler({
      strategy: 'auto',
      static: { fetchImpl: htmlFetch(CAPTCHA_WALL) },
      browser: { profileDir: '/tmp/demandx/profile', launch },
    });

    await expect(crawler.crawl(PAGE_URL)).resolves.toEqual({
      status: 'needs_human',
      reason: 'captcha',
      url: PAGE_URL,
    });
    expect(launch).not.toHaveBeenCalled();
  });

  it('returns the static tier result when no browser is configured', async () => {
    const crawler = createCrawler({
      strategy: 'auto',
      static: { fetchImpl: htmlFetch(LOGIN_WALL) },
    });

    await expect(crawler.crawl(PAGE_URL)).resolves.toEqual({
      status: 'needs_human',
      reason: 'login',
      url: PAGE_URL,
    });
  });

  it('disposes a browser context only when one was launched', async () => {
    const unused = browserHarness(article);
    const staticOnly = createCrawler({
      strategy: 'auto',
      static: { fetchImpl: htmlFetch(article) },
    });
    await staticOnly.crawl(PAGE_URL);
    await staticOnly.dispose();
    expect(unused.launch).not.toHaveBeenCalled();

    const { launch, context } = browserHarness(article);
    const escalated = createCrawler({
      strategy: 'auto',
      static: { fetchImpl: htmlFetch(LOGIN_WALL) },
      browser: { profileDir: '/tmp/demandx/profile', launch },
    });
    await escalated.crawl(PAGE_URL);
    await escalated.dispose();

    expect(launch).toHaveBeenCalledTimes(1);
    expect(context.close).toHaveBeenCalledTimes(1);
  });
});

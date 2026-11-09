import { existsSync } from 'node:fs';

import type { CrawlPlatform } from '@/lib/crawl/platform-profile';
import { platformProfileDir } from '@/lib/crawl/session-status';
import { applyStealth, humanizeSocialPage } from '@/lib/crawl/stealth';

import type { SearchHit, SearchPort } from './port';

/**
 * Logged-in platform search. The search pages need a real session and are
 * client-rendered, so this port drives the profile's browser (headed, the same
 * rule as the crawler) instead of an HTTP API that does not exist.
 */
interface SocialTarget {
  searchUrl: (query: string) => string;
  /** Which query language this platform can answer. */
  language: 'zh' | 'en';
  itemSelector: string;
  linkSelector: string;
  textSelector?: string;
}

const TARGETS: Readonly<Record<CrawlPlatform, SocialTarget>> = {
  xiaohongshu: {
    searchUrl: (query) =>
      `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(query)}`,
    language: 'zh',
    itemSelector: 'section.note-item, .note-item',
    linkSelector: 'a[href*="/explore/"]',
  },
  douyin: {
    searchUrl: (query) => `https://www.douyin.com/search/${encodeURIComponent(query)}`,
    language: 'zh',
    itemSelector: 'li[data-e2e="scroll-list-item"], div[data-e2e="search-result-item"]',
    linkSelector: 'a[href*="/video/"]',
  },
  zhihu: {
    searchUrl: (query) =>
      `https://www.zhihu.com/search?type=content&q=${encodeURIComponent(query)}`,
    language: 'zh',
    itemSelector: '.SearchResult-Card, .List-item',
    linkSelector: 'a[href*="/question/"], a[href*="/p/"]',
    textSelector: '.RichText, .ContentItem-title',
  },
  twitter: {
    searchUrl: (query) =>
      `https://x.com/search?q=${encodeURIComponent(query)}&src=typed_query&f=live`,
    language: 'en',
    itemSelector: 'article[data-testid="tweet"]',
    linkSelector: 'a[href*="/status/"]',
    textSelector: '[data-testid="tweetText"]',
  },
};

export function socialSearchUrl(platform: CrawlPlatform, query: string): string {
  return TARGETS[platform].searchUrl(query);
}

function acceptsLanguage(platform: CrawlPlatform, query: string): boolean {
  const hasCjk = /[\u4e00-\u9fff]/.test(query);
  return TARGETS[platform].language === 'zh' ? hasCjk : !hasCjk;
}

interface RawItem {
  url: string;
  title: string;
  text: string;
}

/** One platform, one query per scan: a search page plus a human-like scroll. */
export function createSocialSearch(platform: CrawlPlatform): SearchPort {
  return {
    id: platform,
    platform,
    maxQueries: 1,
    supportsQuery: (query) => acceptsLanguage(platform, query),
    async search(query, opts): Promise<SearchHit[]> {
      const profileDir = platformProfileDir(platform);
      // No profile means the operator never logged in; never launch a window.
      if (!existsSync(profileDir)) return [];

      const target = TARGETS[platform];
      let context: Awaited<ReturnType<typeof import('@playwright/test')['chromium']['launchPersistentContext']>> | null =
        null;
      try {
        const { chromium } = await import('@playwright/test');
        const options = {
          headless: false,
          args: [
            '--disable-blink-features=AutomationControlled',
            '--no-first-run',
            '--no-default-browser-check',
          ],
          viewport: null,
          locale: 'zh-CN',
          timezoneId: 'Asia/Shanghai',
        };
        const channel = process.env.CRAWL_BROWSER_CHANNEL?.trim() || 'chrome';
        try {
          context = await chromium.launchPersistentContext(profileDir, {
            ...options,
            channel: channel as 'chrome',
          });
        } catch {
          context = await chromium.launchPersistentContext(profileDir, options);
        }
        await applyStealth(context);

        const page = await context.newPage();
        await page.goto(target.searchUrl(query), {
          waitUntil: 'domcontentloaded',
          timeout: 30_000,
        });
        await page.waitForSelector(target.itemSelector, { timeout: 10_000 }).catch(() => undefined);
        await humanizeSocialPage(page);

        const raw = await page.evaluate(
          (selectors) => {
            const items = [...document.querySelectorAll(selectors.itemSelector)];
            const seen = new Set<string>();
            const results: { url: string; title: string; text: string }[] = [];
            for (const item of items) {
              const anchor = item.querySelector(selectors.linkSelector) ?? item.closest('a');
              const href = anchor?.getAttribute('href');
              if (href === null || href === undefined) continue;
              let url: string;
              try {
                url = new URL(href, location.origin).href;
              } catch {
                continue;
              }
              if (seen.has(url)) continue;
              seen.add(url);
              const textNode =
                selectors.textSelector === null ? null : item.querySelector(selectors.textSelector);
              const text = (
                textNode instanceof HTMLElement ? textNode.innerText : (item as HTMLElement).innerText
              )
                .trim()
                .replace(/\s+/g, ' ');
              if (text.length < 20) continue;
              results.push({ url, title: text.slice(0, 60), text });
              if (results.length >= 12) break;
            }
            return results;
          },
          {
            itemSelector: target.itemSelector,
            linkSelector: target.linkSelector,
            textSelector: target.textSelector ?? null,
          },
        );

        return (raw as RawItem[]).slice(0, opts.limit).map((item) => ({
          url: item.url,
          title: item.title,
          snippet: item.text.slice(0, 300),
          platform,
        }));
      } catch {
        // A login wall, captcha or changed DOM is a skipped source, not a
        // failed scan; other ports still answer.
        return [];
      } finally {
        await context?.close().catch(() => undefined);
      }
    },
  };
}

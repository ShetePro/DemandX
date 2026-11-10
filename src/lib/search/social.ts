import { appendFileSync, existsSync, mkdirSync } from 'node:fs';

import type { Page } from '@playwright/test';
import { homedir } from 'node:os';
import path from 'node:path';

import { isProfileLocked, type CrawlPlatform } from '@/lib/crawl/platform-profile';
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

/** Which supported query each platform serves, so the three Chinese ones differ. */
export const SOCIAL_QUERY_OFFSETS: Readonly<Record<CrawlPlatform, number>> = {
  zhihu: 0,
  xiaohongshu: 1,
  douyin: 2,
  twitter: 0,
};

/**
 * A headed window that closes without results leaves no trace. Mirror each
 * step into a log so "why was it empty" is answerable without re-running.
 */
function socialLog(platform: CrawlPlatform, message: string): void {
  try {
    const dir = path.join(homedir(), '.demandx', 'logs');
    mkdirSync(dir, { recursive: true });
    appendFileSync(
      path.join(dir, `social-${platform}.log`),
      `[${new Date().toISOString()}] ${message}\n`,
    );
  } catch {
    // Logging must never break the scan.
  }
}

export function socialSearchUrl(platform: CrawlPlatform, query: string): string {
  return TARGETS[platform].searchUrl(query);
}

/** Web-search phrasing is far too long for a platform search box. */
const INTENT_ZH: ReadonlySet<string> = new Set([
  '太麻烦', '麻烦', '太贵', '没法', '有没有', '怎么', '如何', '推荐', '求推荐', '求',
  '工具', '软件', '平台', '替代', '替代方案', '方案', '付费', '价格',
  '多少钱', '订阅', '值得', '值得吗', '吐槽', '痛点', '效率低', '手工', '手动', '记录',
]);
const INTENT_EN: ReadonlySet<string> = new Set([
  'how', 'to', 'tool', 'tools', 'software', 'platform', 'best', 'alternative',
  'alternatives', 'pay', 'paid', 'pricing', 'price', 'pain', 'manual', 'for',
  'the', 'a', 'an', 'small', 'business', 'with', 'and',
]);

/**
 * Short keyword query for a platform search box: drop intent/stop words and
 * keep the 3–4 domain terms. "律所 外包 文书起草 太贵 替代方案" becomes
 * "律所 外包 文书起草"; X keeps four English words.
 */
export function socialQueryFor(platform: CrawlPlatform, query: string): string {
  const tokens = query.split(/[\s,，。;；:：!！?？、]+/).filter((token) => token !== '');
  const stop = /[\u4e00-\u9fff]/.test(query) ? INTENT_ZH : INTENT_EN;
  const limit = platform === 'twitter' ? 4 : 3;
  const zh = /[\u4e00-\u9fff]/.test(query);
  const kept = tokens
    .filter((token) => !stop.has(token.toLowerCase()))
    // Chinese planners emit phrase tokens ("餐厅出餐时间对不上"); a search box
    // wants a 2–4 character keyword, not a sentence.
    .map((token) =>
      zh && /[\u4e00-\u9fff]/.test(token) && token.length > 4 ? token.slice(0, 4) : token,
    )
    .slice(0, limit);
  const text = (kept.length > 0 ? kept : tokens.slice(0, Math.min(2, tokens.length))).join(' ');
  const max = platform === 'twitter' ? 48 : 20;
  return text.length > max ? text.slice(0, max).trim() : text;
}

export function socialSupportsQuery(platform: CrawlPlatform, query: string): boolean {
  return acceptsLanguage(platform, query);
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
    queryOffset: SOCIAL_QUERY_OFFSETS[platform],
    supportsQuery: (query) => socialSupportsQuery(platform, query),
    async search(query, opts): Promise<SearchHit[]> {
      const profileDir = platformProfileDir(platform);
      // No profile means the operator never logged in; never launch a window.
      if (!existsSync(profileDir)) return [];
      // The login window (or another scan) owns the profile: a second launch
      // would pile about:blank tabs into it, so skip this platform.
      if (isProfileLocked(profileDir)) {
        socialLog(platform, 'profile is in use (SingletonLock); skipped');
        return [];
      }

      const target = TARGETS[platform];
      let page: Page | null = null;
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

        page = await context.newPage();
        // Platform search boxes need keywords, not the planner's full phrase.
        const socialQuery = socialQueryFor(platform, query);
        socialLog(platform, `search query="${query}" socialQuery="${socialQuery}"`);
        await page.goto(target.searchUrl(socialQuery), {
          waitUntil: 'domcontentloaded',
          timeout: 30_000,
        });
        await page.waitForSelector(target.itemSelector, { timeout: 10_000 }).catch(() => undefined);
        const finalUrl = page.url();
        const title = await page.title().catch(() => '');
        socialLog(platform, `loaded url="${finalUrl}" title="${title.slice(0, 80)}"`);
        await humanizeSocialPage(page);

        const raw = await page.evaluate(
          (selectors: { itemSelector: string; linkSelector: string; textSelector: string | null }) => {
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

        socialLog(platform, `hits=${(raw as RawItem[]).length}`);
        if ((raw as RawItem[]).length === 0 && /login|signin|passport/i.test(finalUrl)) {
          socialLog(platform, 'possible login wall: search redirected to a sign-in page');
        }
        return (raw as RawItem[]).slice(0, opts.limit).map((item) => ({
          url: item.url,
          title: item.title,
          snippet: item.text.slice(0, 300),
          platform,
        }));
      } catch (error) {
        // A login wall, captcha or changed DOM is a skipped source, not a
        // failed scan; other ports still answer.
        socialLog(
          platform,
          `search failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        return [];
      } finally {
        // Close the page before the context: a stuck navigation otherwise
        // leaves an about:blank tab behind in the profile's window.
        await page?.close().catch(() => undefined);
        await context?.close().catch(() => undefined);
      }
    },
  };
}

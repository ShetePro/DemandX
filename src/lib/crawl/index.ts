import type { CrawlPort, CrawlResult } from './port';
import {
  createPlaywrightCrawler,
  type PlaywrightCrawler,
  type PlaywrightCrawlerOptions,
} from './playwright';
import type { RobotsCache } from './robots';
import { createStaticCrawler, type StaticCrawlerOptions } from './static';

/**
 * `static` is one GET, `browser` is always Playwright, `auto` escalates from
 * one to the other and is what the pipeline uses by default.
 */
export type CrawlStrategy = 'static' | 'browser' | 'auto';

export interface CreateCrawlerOptions {
  strategy: CrawlStrategy;
  static?: StaticCrawlerOptions;
  /** Required by `browser`; enables the tier-2 escalation for `auto`. */
  browser?: PlaywrightCrawlerOptions;
  /** When given, a disallowed URL is never fetched by either tier. */
  robots?: RobotsCache;
  /** Records a robots skip; the result reports it as `needs_human`/`blocked`. */
  onRobotsSkip?: (url: string) => void;
}

export interface Crawler extends CrawlPort {
  /** Releases the persistent browser context, if one was ever launched. */
  dispose(): Promise<void>;
}

/**
 * Composite crawler: robots first, then the configured tiers. A tier-1 login
 * wall or an unextractable page (a JS app) escalates to the logged-in browser;
 * captchas and blocks do not, because retrying them is what gets a domain
 * banned. `needs_human` is terminal — it is queued, never re-fetched here.
 */
export function createCrawler(options: CreateCrawlerOptions): Crawler {
  if (options.strategy === 'browser' && options.browser === undefined) {
    throw new Error('browser strategy requires browser options');
  }

  const staticCrawler = createStaticCrawler(options.static);
  let browserCrawler: PlaywrightCrawler | null = null;

  function browser(): PlaywrightCrawler | null {
    if (options.browser === undefined) return null;
    browserCrawler ??= createPlaywrightCrawler(options.browser);
    return browserCrawler;
  }

  return {
    async crawl(url: string): Promise<CrawlResult> {
      if (options.robots !== undefined && !(await options.robots.canFetch(url))) {
        options.onRobotsSkip?.(url);
        // No error code fits a policy skip, and it must not be retried: the
        // decision (manual import, skip) belongs to a person.
        return { status: 'needs_human', reason: 'blocked', url };
      }

      if (options.strategy === 'static') return staticCrawler.crawl(url);
      if (options.strategy === 'browser') return browser()!.crawl(url);

      const first = await staticCrawler.crawl(url);
      if (first.status === 'ok') return first;

      const tier2 = browser();
      if (tier2 === null) return first;

      // Only these two outcomes are worth another fetch: a login wall is exactly
      // what the persistent session is for, and `NOT_HTML` usually means the page
      // is client-rendered.
      const escalates =
        (first.status === 'needs_human' && first.reason === 'login') ||
        (first.status === 'error' && first.code === 'NOT_HTML');
      if (!escalates) return first;

      return tier2.crawl(url);
    },

    async dispose(): Promise<void> {
      await browserCrawler?.dispose();
    },
  };
}

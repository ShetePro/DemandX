import { detectChallenge } from './challenge';
import { isTimeoutError } from './error';
import { extractReadable } from './extract';
import type { CrawlPort, CrawlResult } from './port';

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * The slice of Playwright's API the crawler needs. Keeping it structural lets
 * tests inject a fake launcher — no browser is started in the unit suite.
 */
export interface BrowserPage {
  goto(
    url: string,
    options: { waitUntil: 'domcontentloaded'; timeout: number },
  ): Promise<{ status(): number } | null>;
  content(): Promise<string>;
  close(): Promise<void>;
}

export interface BrowserContext {
  newPage(): Promise<BrowserPage>;
  close(): Promise<void>;
}

export type LaunchPersistent = (
  profileDir: string,
  options: { headless: boolean },
) => Promise<BrowserContext>;

/** A crawl port that also owns a browser context. */
export interface PlaywrightCrawler extends CrawlPort {
  dispose(): Promise<void>;
}

export interface PlaywrightCrawlerOptions {
  /** Holds the platform session cookies; created by the manual login script. */
  profileDir: string;
  /** `false` by default: a human may need to log in or solve a challenge. */
  headless?: boolean;
  /** Injected in tests; production launches Chromium via `@playwright/test`. */
  launch?: LaunchPersistent;
  timeoutMs?: number;
}

async function launchChromium(
  profileDir: string,
  options: { headless: boolean },
): Promise<BrowserContext> {
  // Must stay dynamic: `@playwright/test` is the only Playwright entry this
  // project installs (it re-exports the driver and shares the downloaded
  // browsers) and it is a devDependency. A static import would make a
  // production install without devDependencies fail at module load, taking the
  // static tier down with it; here the failure is confined to the browser tier.
  const { chromium } = await import('@playwright/test');
  return chromium.launchPersistentContext(profileDir, { headless: options.headless });
}

/**
 * Tier 2: a persistent browser profile, so a login performed once by a human
 * keeps working for later crawls. One context is reused for the crawler's
 * lifetime; challenges are reported, never solved.
 */
export function createPlaywrightCrawler(options: PlaywrightCrawlerOptions): PlaywrightCrawler {
  const launch = options.launch ?? launchChromium;
  const headless = options.headless ?? false;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let contextPromise: Promise<BrowserContext> | null = null;

  function context(): Promise<BrowserContext> {
    if (contextPromise === null) {
      // A rejected launch must not poison later crawls.
      contextPromise = launch(options.profileDir, { headless }).catch((error: unknown) => {
        contextPromise = null;
        throw error;
      });
    }
    return contextPromise;
  }

  return {
    async crawl(url: string): Promise<CrawlResult> {
      let page: BrowserPage | null = null;
      try {
        page = await (await context()).newPage();
        const response = await page.goto(url, {
          waitUntil: 'domcontentloaded',
          timeout: timeoutMs,
        });
        const html = await page.content();

        // A 403 from Cloudflare is still a challenge page, so classify the body
        // before the status code.
        const challenge = detectChallenge(html, url);
        if (challenge !== null) return { status: 'needs_human', reason: challenge, url };

        if (response !== null && response.status() >= 400) {
          return { status: 'error', code: 'HTTP_ERROR', url };
        }

        const article = extractReadable(html, url);
        if (article === null) return { status: 'error', code: 'NOT_HTML', url };

        return {
          status: 'ok',
          snapshot: { url, html, text: article.text, title: article.title },
        };
      } catch (error) {
        return { status: 'error', code: isTimeoutError(error) ? 'TIMEOUT' : 'HTTP_ERROR', url };
      } finally {
        if (page !== null) await page.close().catch(() => undefined);
      }
    },

    /** Close the profile so the next `crawl` (or process) starts clean. */
    async dispose(): Promise<void> {
      const pending = contextPromise;
      contextPromise = null;
      if (pending === null) return;
      try {
        await (await pending).close();
      } catch {
        // Already closed, or the launch itself failed: disposal is best effort.
      }
    },
  };
}

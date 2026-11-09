import { detectChallenge } from './challenge';
import { isTimeoutError } from './error';
import { extractReadable } from './extract';
import { platformForUrl } from './platform-profile';
import type { CrawlPort, CrawlResult } from './port';
import { applyStealth, domDigest, humanizeSocialPage } from './stealth';

const DEFAULT_TIMEOUT_MS = 30_000;
/** Hydration budget: a CSR app that misses it is still read, just un-settled. */
const DEFAULT_SETTLE_TIMEOUT_MS = 8_000;
/** Structure every article-shaped page has once its content has rendered. */
const DEFAULT_WAIT_FOR_SELECTOR = 'main, article, [role="main"]';

/**
 * The slice of Playwright's API the crawler needs. Keeping it structural lets
 * tests inject a fake launcher — no browser is started in the unit suite.
 */
export interface BrowserPage {
  goto(
    url: string,
    options: { waitUntil: 'domcontentloaded'; timeout: number },
  ): Promise<{ status(): number } | null>;
  waitForSelector(selector: string, options: { timeout: number }): Promise<unknown>;
  content(): Promise<string>;
  close(): Promise<void>;
  /** Optional so the unit fakes stay tiny; the real page always has it. */
  evaluate?: <T>(fn: () => T) => Promise<T>;
  mouse?: { move(x: number, y: number, options?: { steps?: number }): Promise<void> };
}

export interface BrowserContext {
  newPage(): Promise<BrowserPage>;
  close(): Promise<void>;
  addInitScript?: (script: string) => Promise<unknown>;
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
  /**
   * Holds the platform session cookies; created by the manual login script.
   * A resolver lets one crawler serve several logged-in platforms: each
   * distinct directory is launched once and reused.
   */
  profileDir: string | ((url: string) => string);
  /** `false` by default: a human may need to log in or solve a challenge. */
  headless?: boolean;
  /** Injected in tests; production launches Chromium via `@playwright/test`. */
  launch?: LaunchPersistent;
  timeoutMs?: number;
  /**
   * Element that marks the page as hydrated. Waiting for it is what stops a
   * client-rendered app from being classified `NOT_HTML` while its shell is all
   * that exists.
   */
  waitForSelector?: string;
  /** How long to wait for that element; a miss is recorded, not fatal. */
  settleTimeoutMs?: number;
}

/** Flags a normal Chrome window has; automation-only flags stay off. */
const LAUNCH_ARGS = [
  '--disable-blink-features=AutomationControlled',
  '--no-first-run',
  '--no-default-browser-check',
];

const LAUNCH_OPTIONS = {
  args: LAUNCH_ARGS,
  // `null` keeps the real window size in headed mode; a fixed viewport is one
  // of the cheapest automation signals.
  viewport: null,
  locale: 'zh-CN',
  timezoneId: 'Asia/Shanghai',
} as const;

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
  const channel = process.env.CRAWL_BROWSER_CHANNEL?.trim() || 'chrome';

  // Prefer the operator's real Chrome: its TLS/HTTP fingerprint and fonts are
  // what a normal browser on this machine looks like.
  if (channel !== 'bundled') {
    try {
      const context = await chromium.launchPersistentContext(profileDir, {
        ...LAUNCH_OPTIONS,
        headless: options.headless,
        channel: channel as 'chrome',
      });
      await applyStealth(context);
      return context;
    } catch {
      // Chrome is not installed at that channel; fall back to the bundle.
    }
  }

  const context = await chromium.launchPersistentContext(profileDir, {
    ...LAUNCH_OPTIONS,
    headless: options.headless,
  });
  await applyStealth(context);
  return context;
}

/**
 * Tier 2: persistent browser profiles, so a login performed once by a human
 * keeps working for later crawls. One context per profile directory is reused
 * for the crawler's lifetime; challenges are reported, never solved.
 */
export function createPlaywrightCrawler(options: PlaywrightCrawlerOptions): PlaywrightCrawler {
  const launch = options.launch ?? launchChromium;
  const headless = options.headless ?? false;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const waitForSelector = options.waitForSelector ?? DEFAULT_WAIT_FOR_SELECTOR;
  const settleTimeoutMs = options.settleTimeoutMs ?? DEFAULT_SETTLE_TIMEOUT_MS;
  const fixedProfile = options.profileDir;
  const profileFor = typeof fixedProfile === 'string' ? () => fixedProfile : fixedProfile;

  /**
   * One launch per (profile, headless) pair, shared by every URL that resolves
   * to it. Social profiles are forced headed: a headless session on a
   * logged-in account is the fastest route to a ban.
   */
  const contexts = new Map<string, Promise<BrowserContext>>();

  function contextFor(profileDir: string, sessionHeadless: boolean): Promise<BrowserContext> {
    const key = `${profileDir}|${sessionHeadless}`;
    const cached = contexts.get(key);
    if (cached !== undefined) return cached;

    // A rejected launch must not poison later crawls for this profile.
    const created = launch(profileDir, { headless: sessionHeadless }).catch((error: unknown) => {
      contexts.delete(key);
      throw error;
    });
    contexts.set(key, created);
    return created;
  }

  return {
    async crawl(url: string): Promise<CrawlResult> {
      let page: BrowserPage | null = null;
      try {
        const social = platformForUrl(url) !== null;
        // Logged-in platforms: a real headed window, never the configured
        // headless mode; a headless session on the same profile is a ban signal.
        const sessionHeadless = social ? false : headless;
        page = await (await contextFor(profileFor(url), sessionHeadless)).newPage();
        const response = await page.goto(url, {
          waitUntil: 'domcontentloaded',
          timeout: timeoutMs,
        });

        // Best effort: a page that never renders the marker is still read, and
        // `settled: false` tells the caller the snapshot may be incomplete.
        let settled = true;
        try {
          await page.waitForSelector(waitForSelector, { timeout: settleTimeoutMs });
        } catch {
          settled = false;
        }

        // Logged-in social pages: a few seconds of human-like scrolling and
        // pointer movement before reading, then take the rendered post text.
        // Failures here are cosmetic; the page is still read.
        let rendered = '';
        if (social) {
          try {
            await humanizeSocialPage(page);
            rendered = await domDigest(page);
          } catch {
            rendered = '';
          }
        }

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

        // A CSR timeline is invisible to jsdom; append the live DOM text when
        // the readable extraction did not already contain it.
        const text =
          rendered !== '' && !article.text.includes(rendered.slice(0, 80))
            ? `${article.text}\n\n${rendered}`
            : article.text;

        return {
          status: 'ok',
          snapshot: { url, html, text, title: article.title },
          settled,
        };
      } catch (error) {
        return { status: 'error', code: isTimeoutError(error) ? 'TIMEOUT' : 'HTTP_ERROR', url };
      } finally {
        if (page !== null) await page.close().catch(() => undefined);
      }
    },

    /** Close every launched profile so the next `crawl` (or process) starts clean. */
    async dispose(): Promise<void> {
      const pending = [...contexts.values()];
      contexts.clear();

      await Promise.all(
        pending.map(async (contextPromise) => {
          try {
            await (await contextPromise).close();
          } catch {
            // Already closed, or the launch itself failed: disposal is best effort.
          }
        }),
      );
    },
  };
}

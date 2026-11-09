import { appendFileSync, mkdirSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';

import { PLATFORM_LOGIN_URLS } from '@/lib/crawl/platform-profile';
import { applyStealth } from '@/lib/crawl/stealth';

/**
 * `pnpm crawl:login <platform> [url]` opens a headed browser on a persistent
 * profile so a human can log in once. Cookies stay in that profile directory —
 * this script never reads, prints or stores them.
 */
export const LOGIN_USAGE =
  '用法：pnpm crawl:login <platform> [url]\n' +
  '例如：pnpm crawl:login xiaohongshu https://www.xiaohongshu.com';

export interface LoginTarget {
  platform: string;
  /** Opened before the browser waits for the human; optional. */
  url?: string;
  /** `~/.demandx/browser/<platform>`, never inside the repository. */
  profileDir: string;
}

/** Directory names must not escape the browser root. */
const PLATFORM_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;

/**
 * Parse `<platform> [url]` and derive the profile path from the *injected*
 * `home`, so tests never touch the real `~` and `~` always means the caller's
 * home rather than the repository checkout.
 */
export function resolveLoginTarget(argv: string[], home: string): LoginTarget {
  const [platform, url, ...rest] = argv;

  if (platform === undefined || platform.trim() === '') {
    throw new Error(`缺少平台参数。\n${LOGIN_USAGE}`);
  }
  if (!PLATFORM_PATTERN.test(platform)) {
    throw new Error(`平台名只能包含字母、数字、点、下划线和连字符：${platform}\n${LOGIN_USAGE}`);
  }
  if (rest.length > 0) {
    throw new Error(`参数过多：${rest.join(' ')}\n${LOGIN_USAGE}`);
  }
  if (url !== undefined) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`url 不是合法的绝对地址：${url}\n${LOGIN_USAGE}`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`url 必须是 http(s)：${url}\n${LOGIN_USAGE}`);
    }
  }

  const profileDir = path.join(home, '.demandx', 'browser', platform);
  return url === undefined ? { platform, profileDir } : { platform, url, profileDir };
}

/**
 * The settings page spawns this detached with stdio ignored, so a blank window
 * has no visible error. Mirror every step into a log the operator can read
 * (and that never contains cookies).
 */
function createLogger(platform: string): (message: string) => void {
  const dir = path.join(homedir(), '.demandx', 'logs');
  const file = path.join(dir, `login-${platform}.log`);

  return (message: string) => {
    console.log(message);
    try {
      mkdirSync(dir, { recursive: true });
      appendFileSync(file, `[${new Date().toISOString()}] ${message}\n`);
    } catch {
      // Logging must never break the login window.
    }
  };
}

/** Explicit URL wins; otherwise the platform's login page. */
export function loginUrlFor(target: LoginTarget): string | undefined {
  return target.url ?? PLATFORM_LOGIN_URLS[target.platform];
}

async function openLogin(argv: string[]): Promise<void> {
  const target = resolveLoginTarget(argv, homedir());
  // Old callers/short commands may omit the URL; default to the platform's
  // login page so the window never opens on about:blank.
  const targetUrl = loginUrlFor(target);
  const log = createLogger(target.platform);
  log(`启动：pnpm crawl:login ${argv.join(' ')}`);
  log(`会话目录：${target.profileDir}`);
  await mkdir(target.profileDir, { recursive: true });

  // Same driver as the crawler; loaded lazily so argument errors never need it.
  const { chromium } = await import('@playwright/test');
  log('启动浏览器…');
  const launchOptions = {
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
  let context;
  try {
    context = await chromium.launchPersistentContext(target.profileDir, {
      ...launchOptions,
      channel: channel as 'chrome',
    });
  } catch {
    // Installed Chrome is unavailable; the bundled Chromium still works.
    context = await chromium.launchPersistentContext(target.profileDir, launchOptions);
  }
  await applyStealth(context);

  try {
    if (targetUrl !== undefined) {
      // Always navigate a fresh tab and close the persistent context's blank
      // start page, so a failed first tab cannot leave the window on about:blank
      // with no address in the bar.
      const blank = context.pages()[0];
      const page = await context.newPage();
      if (blank !== undefined && blank !== page) void blank.close().catch(() => undefined);

      log(`打开 ${targetUrl}`);
      try {
        await page.goto(targetUrl, { waitUntil: 'commit', timeout: 30_000 });
        log(`已跳转：${page.url()}`);
        await page
          .waitForLoadState('domcontentloaded', { timeout: 20_000 })
          .catch(() => log('页面加载较慢，窗口保持打开'));
      } catch (error) {
        // Keep the window open: the operator can retry or type the URL by hand
        // instead of watching the browser close on a transient network error.
        log(
          `打开 ${targetUrl} 失败：${error instanceof Error ? error.message : String(error)}（当前地址：${page.url()}）`,
        );
        log('请在打开的窗口里手动输入网址并完成登录。');
      }
    } else {
      log('未配置登录网址：窗口保持空白，请手动输入。');
    }

    if (stdin.isTTY) {
      console.log('请在打开的浏览器里完成登录，登录完成后回到终端按 Enter。');
      const terminal = createInterface({ input: stdin, output: stdout });
      await terminal.question('');
      terminal.close();
    } else {
      // Started detached from the settings page: there is no terminal to press
      // Enter in, so the window stays open until the operator closes it.
      console.log('请在打开的浏览器里完成登录，登录完成后直接关闭浏览器窗口。');
      // `Promise.withResolvers` needs lib ES2024; this tsconfig targets older.
      await new Promise<void>((resolve) => {
        context.once('close', () => resolve());
      });
    }
  } finally {
    await context.close();
  }
}

// Only run when executed directly: importing this module in tests must not
// launch anything. No top-level await — tsx loads this file as CJS.
const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  openLogin(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

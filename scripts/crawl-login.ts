import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';

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

async function openLogin(argv: string[]): Promise<void> {
  const target = resolveLoginTarget(argv, homedir());
  await mkdir(target.profileDir, { recursive: true });

  // Same driver as the crawler; loaded lazily so argument errors never need it.
  const { chromium } = await import('@playwright/test');
  const context = await chromium.launchPersistentContext(target.profileDir, {
    headless: false,
  });

  try {
    if (target.url !== undefined) {
      const page = context.pages()[0] ?? (await context.newPage());
      try {
        await page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      } catch (error) {
        // Keep the window open: the operator can retry or type the URL by hand
        // instead of watching the browser close on a transient network error.
        console.error(
          `打开 ${target.url} 失败：${error instanceof Error ? error.message : String(error)}`,
        );
        console.error('请在打开的窗口里手动输入网址并完成登录。');
      }
    }

    console.log(`会话目录：${target.profileDir}`);

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

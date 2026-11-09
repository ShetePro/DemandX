/**
 * Real login state, read from the persistent profile's cookies. Only cookie
 * *names* are inspected — values stay inside the browser profile and are never
 * logged or returned.
 */
export const AUTH_COOKIE_NAMES: Readonly<Record<string, readonly string[]>> = {
  xiaohongshu: ['web_session'],
  douyin: ['sessionid', 'sessionid_ss', 'sid_tt'],
  zhihu: ['z_c0'],
  twitter: ['auth_token'],
};

export type LoginState = 'logged-in' | 'logged-out' | 'unknown';

export interface LoginCheck {
  platform: string;
  state: LoginState;
  /** Cookie names that prove a session; never their values. */
  found: string[];
  /** Set when the profile could not be opened (e.g. the login window owns it). */
  message?: string;
}

export interface CookieLike {
  name: string;
  value: string;
}

export interface LoginContextLike {
  cookies(): Promise<CookieLike[]>;
  close(): Promise<void>;
}

export type LaunchForLoginCheck = (profileDir: string) => Promise<LoginContextLike>;

async function launchHeadless(profileDir: string): Promise<LoginContextLike> {
  const { chromium } = await import('@playwright/test');
  const options = {
    headless: true,
    args: ['--disable-blink-features=AutomationControlled'],
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
  };
  try {
    return await chromium.launchPersistentContext(profileDir, {
      ...options,
      channel: (process.env.CRAWL_BROWSER_CHANNEL?.trim() || 'chrome') as 'chrome',
    });
  } catch {
    return chromium.launchPersistentContext(profileDir, options);
  }
}

/** A profile already open elsewhere (the login window) cannot be checked. */
export async function detectLogin(
  profileDir: string,
  platform: string,
  launch: LaunchForLoginCheck = launchHeadless,
): Promise<LoginCheck> {
  const expected = AUTH_COOKIE_NAMES[platform];
  if (expected === undefined) {
    return { platform, state: 'unknown', found: [], message: '没有该平台的登录判定规则' };
  }

  let context: LoginContextLike | null = null;
  try {
    context = await Promise.race([
      launch(profileDir),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('启动浏览器超时')), 20_000);
      }),
    ]);
    const cookies = await context.cookies();
    const names = new Set(cookies.map((cookie) => cookie.name));
    const found = expected.filter((name) => names.has(name));
    return {
      platform,
      state: found.length > 0 ? 'logged-in' : 'logged-out',
      found,
    };
  } catch (error) {
    return {
      platform,
      state: 'unknown',
      found: [],
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await context?.close().catch(() => undefined);
  }
}

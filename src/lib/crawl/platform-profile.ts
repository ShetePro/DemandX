import { existsSync, lstatSync, readlinkSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

/** Platforms with a logged-in persistent browser profile on disk. */
export type CrawlPlatform = 'xiaohongshu' | 'douyin' | 'zhihu' | 'twitter';

/**
 * Host suffixes that belong to a platform. Matched on label boundaries so
 * `xiaohongshu.com.example.com` cannot inherit the logged-in profile.
 */
const PLATFORM_HOSTS: ReadonlyArray<{
  platform: CrawlPlatform;
  hosts: readonly string[];
}> = [
  { platform: 'xiaohongshu', hosts: ['xiaohongshu.com', 'xhslink.com'] },
  { platform: 'douyin', hosts: ['douyin.com'] },
  { platform: 'zhihu', hosts: ['zhihu.com'] },
  { platform: 'twitter', hosts: ['x.com', 'twitter.com'] },
];

/** Default root when the caller does not inject one (dev machine, tests inject tmp). */
export function browserRoot(home: string = homedir()): string {
  return path.join(home, '.demandx', 'browser');
}

/**
 * Which platform owns this URL, if any. Search results point at articles on
 * many sites, so an unmatched host is normal and must fall back, not throw.
 */
export function platformForUrl(url: string): CrawlPlatform | null {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/\.+$/, '');
  } catch {
    return null;
  }
  if (host === '') return null;

  for (const { platform, hosts } of PLATFORM_HOSTS) {
    if (hosts.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))) {
      return platform;
    }
  }
  return null;
}

export interface ProfileDirOptions {
  /** Root that holds one directory per platform. */
  baseDir?: string;
  /** Profile for URLs that belong to no platform (`CRAWL_PROFILE_DIR`). */
  fallback?: string;
}

/**
 * The persistent profile a URL should be crawled with. A platform URL uses the
 * same directory `pnpm crawl:login <platform>` created, so a manual login is
 * actually reused; everything else uses the generic pipeline profile.
 */
export function profileDirFor(url: string, options: ProfileDirOptions = {}): string {
  const baseDir = options.baseDir ?? browserRoot();
  const platform = platformForUrl(url);
  if (platform !== null) return path.join(baseDir, platform);
  return options.fallback ?? path.join(baseDir, 'pipeline');
}


/** Login page per platform; the login script falls back to these. */
/**
 * Chrome writes `SingletonLock` while a browser owns the profile. Launching a
 * second persistent context then either fails or piles about:blank tabs into
 * the running window, so callers check this before launching.
 *
 * The lock is a symlink to `<host>-<pid>`; a crash (or SIGKILL) leaves it
 * behind with a dead pid, which would otherwise disable the platform forever.
 */
export function isProfileLocked(profileDir: string): boolean {
  const lock = path.join(profileDir, 'SingletonLock');
  // Chrome's lock is a symlink to `host-pid` (a dangling target), so
  // `existsSync` would follow it and report false for a perfectly live lock.
  try {
    lstatSync(lock);
  } catch {
    return false;
  }
  let pid: number | null = null;
  try {
    const target = readlinkSync(lock);
    const parsed = Number(target.slice(target.lastIndexOf('-') + 1));
    if (Number.isInteger(parsed) && parsed > 0) pid = parsed;
  } catch {
    // Not a symlink: treat it as a live lock rather than deleting an unknown file.
    return true;
  }
  if (pid === null) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return true;
  }
  for (const name of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
    try {
      unlinkSync(path.join(profileDir, name));
    } catch {
      // Already gone or owned by another user; the next launch reports it.
    }
  }
  return false;
}

export const PLATFORM_LOGIN_URLS: Readonly<Record<string, string>> = {
  xiaohongshu: 'https://www.xiaohongshu.com',
  douyin: 'https://www.douyin.com',
  zhihu: 'https://www.zhihu.com',
  twitter: 'https://x.com',
};

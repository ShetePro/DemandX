import { homedir } from 'node:os';
import path from 'node:path';

/** Platforms with a logged-in persistent browser profile on disk. */
export type CrawlPlatform = 'xiaohongshu' | 'douyin' | 'zhihu';

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

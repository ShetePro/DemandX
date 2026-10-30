import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

/** Platforms the crawl settings page offers a login button for. */
export const PLATFORMS = ['xiaohongshu', 'douyin', 'zhihu'] as const;

export type Platform = (typeof PLATFORMS)[number];

/** A profile directory whose mtime is older than this is treated as logged out. */
export const SESSION_MAX_AGE_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

export type SessionState = 'active' | 'stale' | 'missing';

/**
 * What the page needs to render one platform card. `lastUsedAt` is the profile
 * directory's mtime — a read-only signal; cookie contents are never opened.
 */
export interface SessionStatus {
  platform: string;
  state: SessionState;
  /** `~/.demandx/browser/<platform>`, outside the repository. */
  profileDir: string;
  lastUsedAt: Date | null;
}

/** Directory names must not escape the browser root. */
const PLATFORM_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;

export function browserRoot(home: string = homedir()): string {
  return path.join(home, '.demandx', 'browser');
}

export function platformProfileDir(platform: string, home: string = homedir()): string {
  if (!PLATFORM_PATTERN.test(platform)) {
    throw new Error(`平台名只能包含字母、数字、点、下划线和连字符：${platform}`);
  }
  return path.join(browserRoot(home), platform);
}

function isMissing(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/**
 * Inspect a platform profile directory without reading anything inside it. An
 * existing directory last modified within `maxAgeDays` is `active`, an older
 * one is `stale` (the login has probably expired), and an absent one is
 * `missing`. Other filesystem errors are rethrown: a permission problem must
 * not be displayed as "not logged in".
 */
export async function readSessionStatus(
  platform: string,
  options: {
    home?: string;
    now?: Date;
    maxAgeDays?: number;
  } = {},
): Promise<SessionStatus> {
  const profileDir = platformProfileDir(platform, options.home);
  const now = options.now ?? new Date();
  const maxAgeDays = options.maxAgeDays ?? SESSION_MAX_AGE_DAYS;

  let info;
  try {
    info = await stat(profileDir);
  } catch (error) {
    if (isMissing(error)) {
      return { platform, state: 'missing', profileDir, lastUsedAt: null };
    }
    throw error;
  }

  if (!info.isDirectory()) {
    return { platform, state: 'missing', profileDir, lastUsedAt: null };
  }

  const lastUsedAt = info.mtime;
  const ageMs = now.getTime() - lastUsedAt.getTime();
  // A future mtime (clock skew, restored backup) is still a recent touch.
  const fresh = ageMs <= maxAgeDays * DAY_MS;
  return { platform, state: fresh ? 'active' : 'stale', profileDir, lastUsedAt };
}

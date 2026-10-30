/**
 * `robots.txt` subset the crawler honours: the `User-agent: *` group, `Allow`
 * and `Disallow` paths, with `*` and `$` wildcards. Groups aimed at other
 * crawlers are parsed but discarded, so we never claim a permission that was
 * meant for Googlebot.
 */
export interface RobotsRule {
  allow: boolean;
  /** Raw pattern from the file, e.g. `/search`, `/private/*`, `/*.pdf$`. */
  path: string;
}

export interface Robots {
  rules: RobotsRule[];
}

/** Fetch one `robots.txt` document; production wraps `fetch` + timeout. */
export type FetchRobots = (robotsUrl: string) => Promise<string>;

export interface RobotsCacheOptions {
  fetchRobots: FetchRobots;
  /** Re-read interval per origin; a day matches how rarely rules change. */
  ttlMs?: number;
  /** Injected clock so tests never wait. */
  now?: () => number;
  /**
   * Called when `robots.txt` cannot be read. The fetch is still allowed —
   * an unreachable policy file must not stall the pipeline — so this hook is
   * where the skip gets recorded.
   */
  onError?: (origin: string, error: unknown) => void;
}

export interface RobotsCache {
  canFetch(url: string): Promise<boolean>;
}

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

/** Most-specific match wins; identical specificity lets `Allow` take it. */
function patternMatches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const source = body.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${source}${anchored ? '$' : ''}`).test(path);
}

/**
 * Collect the rules of every `User-agent: *` group. Consecutive `User-agent`
 * lines share one group; the first rule line closes that group, so a later
 * `User-agent` starts a new one.
 */
export function parseRobots(text: string): Robots {
  const rules: RobotsRule[] = [];
  let inGroup = false;
  let groupIsWildcard = false;
  let groupHasRules = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (line === '') continue;

    const separator = line.indexOf(':');
    if (separator <= 0) continue;
    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();

    if (field === 'user-agent') {
      if (!inGroup || groupHasRules) {
        inGroup = true;
        groupIsWildcard = false;
        groupHasRules = false;
      }
      if (value === '*') groupIsWildcard = true;
      continue;
    }

    if (field !== 'allow' && field !== 'disallow') continue;
    // `Disallow:` with an empty value means "no restriction", not "nothing".
    if (value === '') continue;
    groupHasRules = true;
    if (inGroup && groupIsWildcard) rules.push({ allow: field === 'allow', path: value });
  }

  return { rules };
}

/**
 * Longest matching pattern decides; when two patterns have the same length an
 * `Allow` beats a `Disallow`. No matching rule means the path is allowed.
 */
export function isAllowed(path: string, robots: Robots): boolean {
  const target = path.startsWith('/') ? path : `/${path}`;
  let best: { length: number; allow: boolean } | null = null;

  for (const rule of robots.rules) {
    if (!patternMatches(rule.path, target)) continue;
    const length = rule.path.length;
    const wins =
      best === null ||
      length > best.length ||
      (length === best.length && rule.allow && !best.allow);
    if (wins) best = { length, allow: rule.allow };
  }

  return best === null ? true : best.allow;
}

/**
 * One `robots.txt` per origin, memoised for `ttlMs`. Read failures are treated
 * as "allowed" and cached like any other answer, so a flaky host costs one
 * failed request per TTL rather than one per page.
 */
export function createRobotsCache(options: RobotsCacheOptions): RobotsCache {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const now = options.now ?? Date.now;
  const entries = new Map<string, { robots: Robots; expiresAt: number }>();
  const pending = new Map<string, Promise<Robots>>();

  function load(origin: string): Promise<Robots> {
    const cached = entries.get(origin);
    if (cached !== undefined && cached.expiresAt > now()) return Promise.resolve(cached.robots);

    const inFlight = pending.get(origin);
    if (inFlight !== undefined) return inFlight;

    const task = (async (): Promise<Robots> => {
      try {
        const rules = parseRobots(await options.fetchRobots(`${origin}/robots.txt`));
        entries.set(origin, { robots: rules, expiresAt: now() + ttlMs });
        return rules;
      } catch (error) {
        options.onError?.(origin, error);
        const permissive: Robots = { rules: [] };
        entries.set(origin, { robots: permissive, expiresAt: now() + ttlMs });
        return permissive;
      } finally {
        pending.delete(origin);
      }
    })();

    pending.set(origin, task);
    return task;
  }

  return {
    async canFetch(url: string): Promise<boolean> {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        // Not a URL we can police: let the fetch itself report the failure.
        return true;
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return true;

      const robots = await load(parsed.origin);
      return isAllowed(`${parsed.pathname}${parsed.search}`, robots);
    },
  };
}

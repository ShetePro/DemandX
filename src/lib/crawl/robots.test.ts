import { describe, expect, it, vi } from 'vitest';

import { createRobotsCache, isAllowed, parseRobots } from './robots';

const DISALLOW_ALL_OTHERS = [
  'User-agent: Googlebot',
  'Disallow: /',
  '',
  'User-agent: *',
  'Disallow: /admin',
].join('\n');

describe('parseRobots + isAllowed', () => {
  const cases: Array<{ name: string; robots: string; path: string; allowed: boolean }> = [
    { name: 'empty file allows everything', robots: '', path: '/anything', allowed: true },
    {
      name: 'Disallow matches a prefix',
      robots: 'User-agent: *\nDisallow: /private',
      path: '/private/draft',
      allowed: false,
    },
    {
      name: 'Disallow leaves unrelated paths alone',
      robots: 'User-agent: *\nDisallow: /private',
      path: '/public/note',
      allowed: true,
    },
    {
      name: 'a longer Allow overrides a shorter Disallow',
      robots: 'User-agent: *\nDisallow: /private\nAllow: /private/public',
      path: '/private/public/post',
      allowed: true,
    },
    {
      name: 'longest match wins for Disallow too',
      robots: 'User-agent: *\nAllow: /a\nDisallow: /a/b',
      path: '/a/b/c',
      allowed: false,
    },
    {
      name: 'identical patterns let Allow win',
      robots: 'User-agent: *\nDisallow: /promo\nAllow: /promo',
      path: '/promo/x',
      allowed: true,
    },
    {
      name: '* matches any run of characters',
      robots: 'User-agent: *\nDisallow: /search*',
      path: '/search?q=node',
      allowed: false,
    },
    {
      name: '$ anchors the pattern to the end',
      robots: 'User-agent: *\nDisallow: /*.pdf$',
      path: '/docs/report.pdf',
      allowed: false,
    },
    {
      name: '$ does not match when the path continues',
      robots: 'User-agent: *\nDisallow: /*.pdf$',
      path: '/docs/report.pdf?download=1',
      allowed: true,
    },
    {
      name: 'groups for other crawlers are ignored',
      robots: DISALLOW_ALL_OTHERS,
      path: '/home',
      allowed: true,
    },
    {
      name: 'the wildcard group still applies when other groups are present',
      robots: DISALLOW_ALL_OTHERS,
      path: '/admin/users',
      allowed: false,
    },
    {
      name: 'an empty Disallow means no restriction',
      robots: 'User-agent: *\nDisallow:',
      path: '/anything',
      allowed: true,
    },
    {
      name: 'comments and blank lines are ignored',
      robots: '# policy\n\nUser-agent: *  # everyone\nDisallow: /tmp  # scratch',
      path: '/tmp/file',
      allowed: false,
    },
    {
      name: 'two wildcard groups are merged',
      robots: 'User-agent: *\nDisallow: /a\n\nUser-agent: *\nDisallow: /b',
      path: '/b/x',
      allowed: false,
    },
  ];

  it.each(cases)('$name', ({ robots, path, allowed }) => {
    expect(isAllowed(path, parseRobots(robots))).toBe(allowed);
  });

  it('discards rules that appear before any User-agent line', () => {
    const robots = parseRobots('Disallow: /orphan\nUser-agent: *\nDisallow: /real');

    expect(robots.rules).toEqual([{ allow: false, path: '/real' }]);
  });
});

describe('createRobotsCache', () => {
  it('checks path and query of the requested URL', async () => {
    const fetchRobots = vi.fn(async () => 'User-agent: *\nDisallow: /search');
    const cache = createRobotsCache({ fetchRobots });

    await expect(cache.canFetch('https://example.com/search?q=node')).resolves.toBe(false);
    await expect(cache.canFetch('https://example.com/posts/1')).resolves.toBe(true);
    expect(fetchRobots).toHaveBeenCalledWith('https://example.com/robots.txt');
  });

  it('reads each origin once per TTL', async () => {
    const fetchRobots = vi.fn(async () => 'User-agent: *\nDisallow: /private');
    const cache = createRobotsCache({ fetchRobots });

    await cache.canFetch('https://example.com/a');
    await cache.canFetch('https://example.com/private/b');

    expect(fetchRobots).toHaveBeenCalledTimes(1);
  });

  it('re-reads after the TTL expires', async () => {
    let clock = 0;
    const fetchRobots = vi.fn(async () => 'User-agent: *\nDisallow: /private');
    const cache = createRobotsCache({ fetchRobots, ttlMs: 1_000, now: () => clock });

    await cache.canFetch('https://example.com/a');
    clock = 999;
    await cache.canFetch('https://example.com/a');
    expect(fetchRobots).toHaveBeenCalledTimes(1);

    clock = 1_000;
    await cache.canFetch('https://example.com/a');
    expect(fetchRobots).toHaveBeenCalledTimes(2);
  });

  it('allows the fetch and reports the error when robots.txt is unreachable', async () => {
    const onError = vi.fn();
    const failure = new Error('ECONNREFUSED');
    const cache = createRobotsCache({
      fetchRobots: async () => {
        throw failure;
      },
      onError,
    });

    await expect(cache.canFetch('https://example.com/private/x')).resolves.toBe(true);
    expect(onError).toHaveBeenCalledWith('https://example.com', failure);
  });

  it('does not police URLs it cannot parse', async () => {
    const fetchRobots = vi.fn(async () => 'User-agent: *\nDisallow: /');
    const cache = createRobotsCache({ fetchRobots });

    await expect(cache.canFetch('not a url')).resolves.toBe(true);
    expect(fetchRobots).not.toHaveBeenCalled();
  });
});

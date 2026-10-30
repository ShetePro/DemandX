import { mkdtemp, mkdir, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { SESSION_MAX_AGE_DAYS, platformProfileDir, readSessionStatus } from './session-status';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-10-30T12:00:00.000Z');

const homes: string[] = [];

async function makeHome(): Promise<string> {
  const home = await mkdtemp(path.join(tmpdir(), 'demandx-session-'));
  homes.push(home);
  return home;
}

async function touchProfile(home: string, platform: string, mtime: Date): Promise<void> {
  const dir = platformProfileDir(platform, home);
  await mkdir(dir, { recursive: true });
  await utimes(dir, mtime, mtime);
}

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

describe('readSessionStatus', () => {
  it('reports missing when the platform directory does not exist', async () => {
    const home = await makeHome();

    const status = await readSessionStatus('xiaohongshu', { home, now: NOW });

    expect(status).toMatchObject({
      platform: 'xiaohongshu',
      state: 'missing',
      lastUsedAt: null,
      profileDir: path.join(home, '.demandx', 'browser', 'xiaohongshu'),
    });
  });

  it('reports active when the directory mtime is within the window', async () => {
    const home = await makeHome();
    const touched = new Date(NOW.getTime() - 3 * DAY_MS);
    await touchProfile(home, 'douyin', touched);

    const status = await readSessionStatus('douyin', { home, now: NOW });

    expect(status.state).toBe('active');
    expect(status.lastUsedAt?.getTime()).toBe(touched.getTime());
  });

  it('reports stale when the directory mtime is older than the window', async () => {
    const home = await makeHome();
    const touched = new Date(NOW.getTime() - (SESSION_MAX_AGE_DAYS + 1) * DAY_MS);
    await touchProfile(home, 'zhihu', touched);

    const status = await readSessionStatus('zhihu', { home, now: NOW });

    expect(status.state).toBe('stale');
    expect(status.lastUsedAt?.getTime()).toBe(touched.getTime());
  });

  it('never lets a platform name escape the browser root', () => {
    expect(() => platformProfileDir('../secrets')).toThrow(/平台名/);
    expect(() => platformProfileDir('a/b')).toThrow(/平台名/);
  });
});

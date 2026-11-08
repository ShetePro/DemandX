import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const unref = vi.fn();
  const on = vi.fn();
  const spawn = vi.fn(() => ({ unref, on }));
  return { spawn, unref, on };
});

vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

// The real store opens a database connection at import time; this suite only
// exercises the spawn boundary.
vi.mock('@/lib/settings/store', () => ({
  CRAWL_SETTINGS_KEY: 'crawl',
  DEFAULT_CRAWL_SETTINGS: {
    enabled: true,
    respectRobots: true,
    perHostConcurrency: 1,
    minDelayMs: 3000,
    maxDelayMs: 8000,
    maxPagesPerRun: 120,
    deadlineMinutes: 90,
  },
  crawlSettingsSchema: { safeParse: () => ({ success: false, error: { issues: [] } }) },
  getSetting: vi.fn(),
  setSetting: vi.fn(),
}));

vi.mock('@/lib/runs/queue', () => ({ enqueueS1: vi.fn() }));

import { startLoginAction } from './actions';

beforeEach(() => {
  mocks.spawn.mockClear();
  mocks.unref.mockClear();
  mocks.on.mockClear();
});

describe('startLoginAction', () => {
  it('spawns a detached login process and returns without waiting for it', async () => {
    const result = await startLoginAction('xiaohongshu');

    expect(result).toEqual({
      ok: true,
      value: { started: true, url: 'https://www.xiaohongshu.com' },
    });
    expect(mocks.spawn).toHaveBeenCalledWith(
      'pnpm',
      ['crawl:login', 'xiaohongshu', 'https://www.xiaohongshu.com'],
      {
      cwd: process.cwd(),
      detached: true,
      stdio: 'ignore',
        env: process.env,
      },
    );
    expect(mocks.unref).toHaveBeenCalledTimes(1);
    // An unhandled 'error' event would crash the server process.
    expect(mocks.on).toHaveBeenCalledWith('error', expect.any(Function));
  });

  it('refuses a platform name that could escape the browser root', async () => {
    const result = await startLoginAction('../secrets');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('VALIDATION_FAILED');
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
});

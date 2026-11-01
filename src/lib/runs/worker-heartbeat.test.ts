import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ getSetting: vi.fn(), setSetting: vi.fn() }));

vi.mock('@/lib/settings/store', () => ({
  getSetting: mocks.getSetting,
  setSetting: mocks.setSetting,
}));

import { readWorkerStatus, WORKER_STALE_MS } from './worker-heartbeat';

beforeEach(() => {
  mocks.getSetting.mockReset();
  mocks.setSetting.mockReset();
});

describe('readWorkerStatus', () => {
  it('is offline when the worker never checked in', async () => {
    mocks.getSetting.mockResolvedValue({ ok: true, value: null });
    await expect(readWorkerStatus()).resolves.toEqual({ online: false, at: null });
  });

  it('is online while the check-in is fresh', async () => {
    const now = new Date('2026-11-01T12:00:00.000Z');
    mocks.getSetting.mockResolvedValue({
      ok: true,
      value: { at: new Date(now.getTime() - 10_000).toISOString() },
    });

    const status = await readWorkerStatus(now);
    expect(status.online).toBe(true);
    expect(status.at?.toISOString()).toBe('2026-11-01T11:59:50.000Z');
  });

  it('goes offline once the check-in is older than the stale window', async () => {
    const now = new Date('2026-11-01T12:00:00.000Z');
    mocks.getSetting.mockResolvedValue({
      ok: true,
      value: { at: new Date(now.getTime() - WORKER_STALE_MS - 1).toISOString() },
    });

    await expect(readWorkerStatus(now)).resolves.toMatchObject({ online: false });
  });

  it('treats a malformed timestamp as offline', async () => {
    mocks.getSetting.mockResolvedValue({ ok: true, value: { at: 'not-a-date' } });
    await expect(readWorkerStatus()).resolves.toEqual({ online: false, at: null });
  });
});

import { describe, expect, it } from 'vitest';

import { summarizePlatformUsage, type UsageRow } from './platform-usage';

function row(overrides: Partial<UsageRow> = {}): UsageRow {
  return {
    url: 'https://www.xiaohongshu.com/explore/1',
    tier: 'browser',
    runId: 1,
    fetchedAt: new Date('2026-11-01T00:00:00Z'),
    ...overrides,
  };
}

describe('summarizePlatformUsage', () => {
  it('counts pages, distinct runs and the latest fetch per platform', () => {
    const usage = summarizePlatformUsage([
      row({ runId: 1 }),
      row({ runId: 1, url: 'https://www.xiaohongshu.com/explore/2' }),
      row({ runId: 2, url: 'https://x.com/a/status/1', tier: 'browser' }),
      row({ url: 'https://example.com/article' }),
    ]);

    const xhs = usage.find((item) => item.platform === 'xiaohongshu');
    expect(xhs).toMatchObject({ pages: 2, runs: 1, tiers: { browser: 2 } });
    expect(usage.find((item) => item.platform === 'twitter')?.pages).toBe(1);
    expect(usage.find((item) => item.platform === 'zhihu')?.pages).toBe(0);
  });

  it('always returns a row per supported platform', () => {
    expect(summarizePlatformUsage([]).map((item) => item.platform)).toEqual([
      'xiaohongshu',
      'douyin',
      'zhihu',
      'twitter',
    ]);
  });
});

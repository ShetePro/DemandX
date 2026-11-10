import path from 'node:path';

import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';

import { acquireSearchLock, createSocialSearch, socialQueryFor, socialSearchUrl } from './social';

describe('social search', () => {
  it('builds each platform search URL with the encoded query', () => {
    expect(socialSearchUrl('zhihu', '发票 工具')).toContain(encodeURIComponent('发票 工具'));
    expect(socialSearchUrl('xiaohongshu', '库存')).toContain('/search_result?keyword=');
    expect(socialSearchUrl('douyin', '排班')).toContain('/search/');
    expect(socialSearchUrl('twitter', 'invoice tool')).toContain('/search?q=');
  });

  it('routes Chinese queries to Chinese platforms and English to X', () => {
    const zhihu = createSocialSearch('zhihu');
    const x = createSocialSearch('twitter');
    expect(zhihu.supportsQuery?.('发票 工具')).toBe(true);
    expect(zhihu.supportsQuery?.('invoice tool')).toBe(false);
    expect(x.supportsQuery?.('invoice tool')).toBe(true);
    expect(x.supportsQuery?.('发票 工具')).toBe(false);
  });

  it('caps a platform to one query per scan and tags the platform', () => {
    const zhihu = createSocialSearch('zhihu');
    expect(zhihu.maxQueries).toBe(1);
    expect(zhihu.platform).toBe('zhihu');
  });
});


describe('socialQueryFor', () => {
  it('cuts a planner phrase down to platform keywords', () => {
    expect(socialQueryFor('zhihu', '律所 外包 文书起草 太贵 替代方案')).toBe('律所 外包 文书起草');
    expect(socialQueryFor('xiaohongshu', '诊所 排班 excel 换班 太麻烦')).toBe('诊所 排班 excel');
  });

  it('keeps four English words for X and drops intent words', () => {
    expect(
      socialQueryFor('twitter', 'invoice reconciliation spreadsheet small business software'),
    ).toBe('invoice reconciliation spreadsheet');
    expect(socialQueryFor('twitter', 'cold email domain banned outreach')).toBe(
      'cold email domain banned',
    );
  });

  it('shortens long Chinese phrase tokens to keywords', () => {
    expect(socialQueryFor('xiaohongshu', '餐厅出餐时间对不上 前厅后厨催单 记录')).toBe(
      '餐厅出餐 前厅后厨',
    );
  });

  it('falls back to the first terms when everything is an intent word', () => {
    expect(socialQueryFor('zhihu', '工具 软件 推荐')).toBe('工具 软件');
  });
});


describe('acquireSearchLock', () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('lets one caller own a profile and blocks the rest until release', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'demandx-social-'));
    dirs.push(dir);

    const release = acquireSearchLock(dir);
    expect(release).not.toBeNull();
    expect(acquireSearchLock(dir)).toBeNull();

    release?.();
    const again = acquireSearchLock(dir);
    expect(again).not.toBeNull();
    again?.();
  });

  it('takes over a stale lock left by a crashed search', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'demandx-social-'));
    dirs.push(dir);
    const lock = path.join(dir, '.demandx-search.lock');
    await writeFile(lock, '999999');
    const old = new Date(Date.now() - 11 * 60_000);
    await utimes(lock, old, old);

    const release = acquireSearchLock(dir);
    expect(release).not.toBeNull();
    release?.();
  });
});

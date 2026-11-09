import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { platformForUrl, profileDirFor } from './platform-profile';

describe('platformForUrl', () => {
  it.each([
    ['https://www.xiaohongshu.com/explore/1', 'xiaohongshu'],
    ['https://xiaohongshu.com/explore/1', 'xiaohongshu'],
    ['https://xhslink.com/a/abc', 'xiaohongshu'],
    ['https://WWW.XIAOHONGSHU.COM./explore/1', 'xiaohongshu'],
    ['https://www.douyin.com/video/123', 'douyin'],
    ['https://v.douyin.com/abc', 'douyin'],
    ['https://www.zhihu.com/question/1', 'zhihu'],
    ['https://x.com/someone/status/1', 'twitter'],
    ['https://twitter.com/someone/status/1', 'twitter'],
    ['https://zhuanlan.zhihu.com/p/1', 'zhihu'],
    ['https://example.com/post', null],
    // A lookalike suffix is not the platform.
    ['https://xiaohongshu.com.evil.example/post', null],
    ['not a url', null],
    ['javascript:alert(1)', null],
  ] as const)('%s → %s', (url, expected) => {
    expect(platformForUrl(url)).toBe(expected);
  });
});

describe('profileDirFor', () => {
  const baseDir = path.join('/tmp', 'demandx-browser');
  const fallback = path.join(baseDir, 'pipeline');

  it('uses the platform directory that the login button writes', () => {
    expect(profileDirFor('https://www.zhihu.com/question/1', { baseDir, fallback })).toBe(
      path.join(baseDir, 'zhihu'),
    );
  });

  it('falls back to the pipeline profile for everything else', () => {
    expect(profileDirFor('https://example.com/post', { baseDir, fallback })).toBe(fallback);
  });

  it('defaults the fallback to <baseDir>/pipeline', () => {
    expect(profileDirFor('https://example.com/post', { baseDir })).toBe(
      path.join(baseDir, 'pipeline'),
    );
  });
});

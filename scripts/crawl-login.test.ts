import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { LOGIN_USAGE, loginUrlFor, resolveLoginTarget } from './crawl-login';

describe('resolveLoginTarget', () => {
  it('rejects a missing platform with the usage text', () => {
    expect(() => resolveLoginTarget([], '/home/lin')).toThrow(LOGIN_USAGE);
    expect(() => resolveLoginTarget(['  '], '/home/lin')).toThrow(/缺少平台参数/);
  });

  it('expands ~ through the injected home for the profile directory', () => {
    const target = resolveLoginTarget(['xiaohongshu'], '/home/lin');

    expect(target).toEqual({
      platform: 'xiaohongshu',
      profileDir: path.join('/home/lin', '.demandx', 'browser', 'xiaohongshu'),
    });
    expect(target.profileDir.startsWith('/home/lin/')).toBe(true);
  });

  it('keeps an optional url and refuses to escape the browser root', () => {
    expect(resolveLoginTarget(['zhihu', 'https://www.zhihu.com'], '/home/lin')).toEqual({
      platform: 'zhihu',
      url: 'https://www.zhihu.com',
      profileDir: path.join('/home/lin', '.demandx', 'browser', 'zhihu'),
    });

    expect(() => resolveLoginTarget(['../etc'], '/home/lin')).toThrow(/平台名/);
    expect(() => resolveLoginTarget(['zhihu', 'javascript:alert(1)'], '/home/lin')).toThrow(
      /http\(s\)/,
    );
  });
});


describe('loginUrlFor', () => {
  it('defaults to the platform login page when no URL is given', () => {
    const target = resolveLoginTarget(['xiaohongshu'], '/home/lin');
    expect(loginUrlFor(target)).toBe('https://www.xiaohongshu.com');
  });

  it('keeps an explicit URL', () => {
    const target = resolveLoginTarget(['zhihu', 'https://www.zhihu.com/signin'], '/home/lin');
    expect(loginUrlFor(target)).toBe('https://www.zhihu.com/signin');
  });

  it('returns undefined for a platform without a default', () => {
    const target = resolveLoginTarget(['example'], '/home/lin');
    expect(loginUrlFor(target)).toBeUndefined();
  });
});

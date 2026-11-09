import { describe, expect, it } from 'vitest';

import { createSocialSearch, socialSearchUrl } from './social';

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

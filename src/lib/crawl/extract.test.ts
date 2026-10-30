import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { extractReadable, MIN_ARTICLE_LENGTH } from './extract';

const fixture = readFileSync(
  new URL('../../../tests/fixtures/crawl/article.html', import.meta.url),
  'utf8',
);

describe('extractReadable', () => {
  it('keeps the article and drops navigation, ads, sidebars and scripts', () => {
    const article = extractReadable(fixture, 'https://example.com/posts/xhs-crawler');

    expect(article?.title).toContain('小红书笔记采集工具为什么总被封');
    expect(article?.text).toContain('我用 Node 写了一个小红书笔记采集脚本');
    expect(article?.text).toContain('正确的做法是先检测响应内容里有没有验证码或登录墙的痕迹');

    // Chrome, promo blocks and tracking code must not reach quotable text.
    expect(article?.text).not.toContain('限时优惠');
    expect(article?.text).not.toContain('赞助商推广位');
    expect(article?.text).not.toContain('热门文章');
    expect(article?.text).not.toContain('关于我们');
    expect(article?.text).not.toContain('window.__TRACKING__');
  });

  it('keeps paragraphs on separate lines with single spaces inside them', () => {
    const article = extractReadable(fixture, 'https://example.com/posts/xhs-crawler');
    const lines = (article?.text ?? '').split('\n');

    expect(lines.length).toBeGreaterThanOrEqual(4);
    for (const line of lines) {
      expect(line).toBe(line.trim());
      expect(line).not.toMatch(/\s{2,}/);
    }
    expect(article?.title).not.toContain('\n');
  });

  it('treats an article shorter than the threshold as no article', () => {
    const short = '<html><body><nav>菜单</nav><p>太短了，不是正文。</p></body></html>';

    expect(MIN_ARTICLE_LENGTH).toBe(80);
    expect(extractReadable(short, 'https://example.com/short')).toBeNull();
  });

  it('returns null for empty or unparseable input', () => {
    expect(extractReadable('', 'https://example.com/empty')).toBeNull();
    expect(extractReadable('   \n ', 'https://example.com/blank')).toBeNull();
  });

  it('still extracts when the URL is not a valid absolute URL', () => {
    const article = extractReadable(fixture, 'not-a-url');

    expect(article?.text).toContain('我用 Node 写了一个小红书笔记采集脚本');
  });
});

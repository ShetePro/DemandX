import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { detectChallenge, MAX_SCAN_CHARS } from './challenge';

const readable = readFileSync(
  new URL('../../../tests/fixtures/crawl/article.html', import.meta.url),
  'utf8',
);

describe('detectChallenge', () => {
  it('detects a captcha widget by its markup', () => {
    const html =
      '<html><body><div class="verify-box"><div id="captcha"></div></div>' +
      '<p>请完成验证后继续</p></body></html>';

    expect(detectChallenge(html, 'https://example.com/note/1')).toBe('captcha');
  });

  it('detects a login wall by its wording', () => {
    const html =
      '<html><body><div class="mask"></div>' +
      '<p>请先登录，登录后查看完整笔记内容</p></body></html>';

    expect(detectChallenge(html, 'https://www.xiaohongshu.com/explore/1')).toBe('login');
  });

  it('detects rate limiting as blocked', () => {
    const html = '<html><body><h1>访问过于频繁</h1><p>请稍后再试</p></body></html>';

    expect(detectChallenge(html, 'https://www.zhihu.com/question/1')).toBe('blocked');
  });

  it('detects a Cloudflare interstitial as blocked', () => {
    const html =
      '<html><body><div id="cf-wrapper"><h1>Just a moment...</h1>' +
      '<p>Checking your browser before accessing the site.</p></div></body></html>';

    expect(detectChallenge(html, 'https://example.com/')).toBe('blocked');
  });

  it('detects a JavaScript-only shell as blocked', () => {
    const html =
      '<html><body><div id="root"></div>' +
      '<p>Please enable JavaScript and refresh the page.</p></body></html>';

    expect(detectChallenge(html, 'https://example.com/app')).toBe('blocked');
  });

  it('falls back to the URL when a login page has no telling copy', () => {
    const html = '<html><body><form action="/session"><input name="user" /></form></body></html>';

    expect(detectChallenge(html, 'https://example.com/login?next=%2Fhome')).toBe('login');
    expect(detectChallenge(html, 'https://example.com/blog/login-flows-explained')).toBeNull();
  });

  it('ignores a login modal parked inside a template', () => {
    const html =
      '<html><body><main><p>正文内容，可以正常阅读。</p></main>' +
      '<template><div id="login-modal"><p>请先登录，登录后查看完整内容</p></div></template>' +
      '</body></html>';

    expect(detectChallenge(html, 'https://example.com/posts/1')).toBeNull();
  });

  it('leaves an ordinary article alone', () => {
    expect(detectChallenge(readable, 'https://example.com/posts/xhs-crawler')).toBeNull();
  });

  it('does not scan past the head of a large document', () => {
    const filler = `<p>${'正文'.repeat(MAX_SCAN_CHARS / 2)}</p>`;
    const html = `<html><body>${filler}<div id="captcha"></div></body></html>`;

    expect(detectChallenge(html, 'https://example.com/long')).toBeNull();
  });
});

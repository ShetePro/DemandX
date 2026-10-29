import { describe, expect, it } from 'vitest';

import { canonicalizeUrl } from './canonical-url';

describe('canonicalizeUrl', () => {
  it('lowercases scheme and host and drops the fragment', () => {
    expect(canonicalizeUrl('HTTPS://Example.COM/Case/Path#section')).toBe(
      'https://example.com/Case/Path',
    );
    expect(canonicalizeUrl('http://A.com/p?x=1#frag')).toBe('http://a.com/p?x=1');
  });

  it('removes tracking params and keeps business params', () => {
    expect(
      canonicalizeUrl(
        'https://a.com/p/?utm_source=newsletter&utm_medium=email&utm_campaign=launch&id=42',
      ),
    ).toBe('https://a.com/p?id=42');
    expect(canonicalizeUrl('https://a.com/p?fbclid=abc&gclid=def&page=2')).toBe(
      'https://a.com/p?page=2',
    );
  });

  it('removes every known tracking parameter', () => {
    const url =
      'https://a.com/p?utm_source=a&utm_medium=b&utm_campaign=c&utm_term=d&utm_content=e' +
      '&fbclid=f&gclid=g&yclid=h&mc_cid=i&mc_eid=j&keep=1';
    expect(canonicalizeUrl(url)).toBe('https://a.com/p?keep=1');
  });

  it('sorts remaining query params by key ascending', () => {
    expect(canonicalizeUrl('https://a.com/s?z=1&a=2&m=3')).toBe('https://a.com/s?a=2&m=3&z=1');
  });

  it('keeps repeated keys in their original order', () => {
    expect(canonicalizeUrl('https://a.com/s?b=2&a=1&a=0')).toBe('https://a.com/s?a=1&a=0&b=2');
  });

  it('drops default ports but keeps explicit non-default ports', () => {
    expect(canonicalizeUrl('http://a.com:80/x')).toBe('http://a.com/x');
    expect(canonicalizeUrl('https://a.com:443/x')).toBe('https://a.com/x');
    expect(canonicalizeUrl('https://a.com:8443/x')).toBe('https://a.com:8443/x');
  });

  it('trims trailing slashes and preserves the root path', () => {
    expect(canonicalizeUrl('https://a.com/a/')).toBe('https://a.com/a');
    expect(canonicalizeUrl('https://a.com/a//')).toBe('https://a.com/a');
    expect(canonicalizeUrl('https://a.com/')).toBe('https://a.com/');
    expect(canonicalizeUrl('https://a.com')).toBe('https://a.com/');
  });

  it('preserves path case and never strips the www prefix', () => {
    expect(canonicalizeUrl('https://www.Example.com/Path/To/')).toBe(
      'https://www.example.com/Path/To',
    );
  });

  it('returns null for non-http(s) and malformed urls', () => {
    expect(canonicalizeUrl('ftp://a.com/x')).toBeNull();
    expect(canonicalizeUrl('mailto:someone@example.com')).toBeNull();
    expect(canonicalizeUrl('javascript:alert(1)')).toBeNull();
    expect(canonicalizeUrl('//a.com/x')).toBeNull();
    expect(canonicalizeUrl('not a url')).toBeNull();
    expect(canonicalizeUrl('')).toBeNull();
    expect(canonicalizeUrl('   ')).toBeNull();
  });

  it('is idempotent', () => {
    const once = canonicalizeUrl('https://A.com:443/p/?utm_source=x&b=2&a=1#frag');
    expect(once).not.toBeNull();
    expect(canonicalizeUrl(once ?? '')).toBe(once);
  });
});

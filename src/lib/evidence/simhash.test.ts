import { describe, expect, it } from 'vitest';

import { fnv1a64, hammingDistance, isNearDuplicate, simhash64, tokenize } from './simhash';

const MASK_64 = 0xffffffffffffffffn;

describe('tokenize', () => {
  it('cuts CJK runs into overlapping 2-grams and keeps lone characters', () => {
    expect(tokenize('中文分词')).toEqual(['中文', '文分', '分词']);
    expect(tokenize('好')).toEqual(['好']);
    expect(tokenize('你好世界')).toEqual(['你好', '好世', '世界']);
  });

  it('lowercases latin words and drops punctuation-only chunks', () => {
    expect(tokenize('Hello, WORLD! 42')).toEqual(['hello', 'world', '42']);
    expect(tokenize('，。！？——')).toEqual([]);
    expect(tokenize('')).toEqual([]);
  });

  it('keeps mixed scripts in reading order', () => {
    expect(tokenize('买 MacBook 还是 Windows？')).toEqual(['买', 'macbook', '还是', 'windows']);
  });
});

describe('fnv1a64', () => {
  it('matches the published FNV-1a 64-bit vectors', () => {
    expect(fnv1a64('')).toBe(0xcbf29ce484222325n);
    expect(fnv1a64('a')).toBe(0xaf63dc4c8601ec8cn);
    expect(fnv1a64('foobar')).toBe(0x85944171f73967e8n);
  });
});

describe('simhash64', () => {
  it('returns 0n for empty and punctuation-only text', () => {
    expect(simhash64('')).toBe(0n);
    expect(simhash64('   ')).toBe(0n);
    expect(simhash64('，。！？')).toBe(0n);
  });

  it('produces the same fingerprint for identical text', () => {
    const text = '用户抱怨订阅价格太高，正在寻找更便宜的替代方案。';
    expect(hammingDistance(simhash64(text), simhash64(text))).toBe(0);
  });

  it('keeps a one-word edit within the near-duplicate threshold', () => {
    const a =
      'The onboarding flow is confusing and takes too long for new users who just want to import their existing data and start working immediately without reading documentation.';
    const b =
      'The onboarding flow is confusing and takes too long for new users who just want to import their existing data and start working immediately without reading the documentation.';

    const distance = hammingDistance(simhash64(a), simhash64(b));
    expect(distance).toBeLessThanOrEqual(3);
    expect(isNearDuplicate(a, b)).toBe(true);
  });

  it('separates unrelated text', () => {
    const a = 'the quick brown fox jumps over the lazy dog and keeps running through the field';
    const b = 'pricing complaints from small business owners on reddit about per seat billing';

    expect(hammingDistance(simhash64(a), simhash64(b))).toBeGreaterThan(3);
    expect(isNearDuplicate(a, b)).toBe(false);
  });
});

describe('hammingDistance', () => {
  it('counts differing bits and stays within 0–64', () => {
    expect(hammingDistance(0n, 0n)).toBe(0);
    expect(hammingDistance(0n, 1n)).toBe(1);
    expect(hammingDistance(0n, MASK_64)).toBe(64);
    expect(hammingDistance(MASK_64, 0n)).toBe(64);

    const fingerprint = simhash64('some reasonably long piece of english text for hashing');
    expect(hammingDistance(fingerprint, fingerprint)).toBe(0);
    expect(hammingDistance(fingerprint, MASK_64 ^ fingerprint)).toBe(64);
  });
});

describe('isNearDuplicate', () => {
  it('falls back to exact equality for short texts', () => {
    expect(isNearDuplicate('你好', '你好')).toBe(true);
    expect(isNearDuplicate('你好', '您好')).toBe(false);
    expect(isNearDuplicate('hello world', 'hello worlds')).toBe(false);
    expect(isNearDuplicate('', '')).toBe(true);
  });

  it('respects a custom threshold', () => {
    const a =
      'The onboarding flow is confusing and takes too long for new users who just want to import their existing data and start working immediately without reading documentation.';
    const b =
      'The onboarding flow is confusing and takes too long for new users who just want to import their existing data and start working immediately without reading the documentation.';

    expect(isNearDuplicate(a, b, 0)).toBe(false);
    expect(isNearDuplicate(a, b, 3)).toBe(true);
  });
});

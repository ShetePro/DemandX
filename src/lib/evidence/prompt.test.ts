import { describe, expect, it } from 'vitest';

import { buildExtractionPrompt, MAX_EXTRACTION_TEXT } from './prompt';

const URL = 'https://www.v2ex.com/t/123456';

describe('buildExtractionPrompt', () => {
  it('truncates the body to 12000 characters', () => {
    const text = `${'正'.repeat(MAX_EXTRACTION_TEXT)}TAIL_MARKER`;

    const { user } = buildExtractionPrompt({ url: URL, platform: 'v2ex', text });

    expect(MAX_EXTRACTION_TEXT).toBe(12_000);
    expect(user).toContain('正'.repeat(MAX_EXTRACTION_TEXT));
    expect(user).not.toContain('TAIL_MARKER');
    expect(user.length).toBeLessThan(MAX_EXTRACTION_TEXT + 200);
  });

  it('keeps short bodies intact', () => {
    const { user } = buildExtractionPrompt({
      url: URL,
      platform: 'v2ex',
      text: '三个平台改库存改到凌晨两点。',
    });

    expect(user).toContain('三个平台改库存改到凌晨两点。');
  });

  it('forbids rewriting in the system prompt', () => {
    const { system } = buildExtractionPrompt({ url: URL, platform: 'v2ex', text: '正文' });

    expect(system).toContain('不得改写');
    expect(system).toContain('不得翻译');
    expect(system).toContain('只摘录原文');
    expect(system).toContain('{"items": []}');
    expect(system).toContain('最多 3 条');
    expect(system).toContain('各不超过 120 字');
  });

  it('carries the platform and url into the user message', () => {
    const { user } = buildExtractionPrompt({
      url: URL,
      platform: 'reddit',
      text: 'I sync stock across three shops every night.',
    });

    expect(user).toContain('reddit');
    expect(user).toContain(URL);
  });
});

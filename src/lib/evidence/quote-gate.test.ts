import { describe, expect, it } from 'vitest';

import { gateQuote, normalizeForMatch } from './quote-gate';

describe('gateQuote: exact match', () => {
  it('returns the offset of an exact substring after Chinese text and newlines', () => {
    const snapshot = '前文。\n「三个平台改库存改到凌晨」\n后文。';

    const result = gateQuote(snapshot, '三个平台改库存改到凌晨');

    expect(result).toEqual({ ok: true, offset: 5, length: 11 });
    if (result.ok)
      expect(snapshot.slice(result.offset, result.offset + result.length)).toBe(
        '三个平台改库存改到凌晨',
      );
  });

  it('accepts a quote equal to the whole snapshot', () => {
    const snapshot = '三个平台改库存改到凌晨';

    expect(gateQuote(snapshot, snapshot)).toEqual({ ok: true, offset: 0, length: snapshot.length });
  });

  it('prefers the exact occurrence over a normalized one', () => {
    const snapshot = '原文 ABC 方案 原文 ABC方案';

    const result = gateQuote(snapshot, 'ABC方案');

    expect(result).toEqual({ ok: true, offset: 13, length: 5 });
  });
});

describe('gateQuote: whitespace-normalized match', () => {
  it('collapses runs of spaces, tabs and newlines and points at the first character', () => {
    const snapshot = '第一段\n\n  第二段\t内容';

    const result = gateQuote(snapshot, '第二段 内容');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.offset).toBe(7);
    expect(snapshot.slice(result.offset, result.offset + result.length)).toBe('第二段\t内容');
  });

  it('collapses full-width spaces (U+3000)', () => {
    const snapshot = '甲乙\u3000\u3000丙丁';

    const result = gateQuote(snapshot, '甲乙 丙丁');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.offset).toBe(0);
    expect(snapshot.slice(result.offset, result.offset + result.length)).toBe(
      '甲乙\u3000\u3000丙丁',
    );
  });

  it('skips leading and trailing whitespace and offsets to the first non-space character', () => {
    const snapshot = '  \n  第二段 内容  ';

    const result = gateQuote(snapshot, '第二段 内容');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.offset).toBe(5);
    expect(snapshot.slice(result.offset, result.offset + result.length)).toBe('第二段 内容');
  });

  it('matches a quote that spans two paragraphs', () => {
    const snapshot = '第一段结束。\n\n第二段开始，这里说明了需求。';

    const result = gateQuote(snapshot, '第一段结束。 第二段开始');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.offset).toBe(0);
    expect(snapshot.slice(result.offset, result.offset + result.length)).toBe(
      '第一段结束。\n\n第二段开始',
    );
  });
});

describe('gateQuote: NFKC normalization', () => {
  it('matches full-width latin letters against ASCII', () => {
    const snapshot = '价格是ＡＢＣ方案每月';

    const result = gateQuote(snapshot, 'ABC方案');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.offset).toBe(3);
    expect(snapshot.slice(result.offset, result.offset + result.length)).toBe('ＡＢＣ方案');
  });

  it('matches full-width digits against ASCII', () => {
    const snapshot = '我每月付１２３元';

    const result = gateQuote(snapshot, '每月付123元');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.offset).toBe(1);
    expect(snapshot.slice(result.offset, result.offset + result.length)).toBe('每月付１２３元');
  });

  it('keeps offsets inside the original text for mixed normalization', () => {
    const snapshot = '标题\n\nＡＢＣ 方案\n正文 １２３ 元';
    const quote = 'ABC 方案 正文 123 元';

    const result = gateQuote(snapshot, quote);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.offset).toBe(4);
    expect(result.offset + result.length).toBeLessThanOrEqual(snapshot.length);
    const sliced = snapshot.slice(result.offset, result.offset + result.length);
    expect(sliced.startsWith('ＡＢＣ')).toBe(true);
    expect(sliced.endsWith('元')).toBe(true);
  });
});

describe('gateQuote: rejections', () => {
  it('rejects a paraphrase of the snapshot', () => {
    const result = gateQuote('原文是三个平台库存同步很麻烦', '多平台库存同步非常麻烦');

    expect(result).toEqual({ ok: false, reason: 'quote_not_in_snapshot' });
  });

  it('rejects a near-miss that differs by one character (no fuzzy matching)', () => {
    const result = gateQuote('三个平台改库存改到凌晨三点', '三个平台改库存改到凌晨四点');

    expect(result).toEqual({ ok: false, reason: 'quote_not_in_snapshot' });
  });

  it('rejects an empty quote', () => {
    expect(gateQuote('三个平台改库存改到凌晨', '')).toEqual({ ok: false, reason: 'empty_quote' });
  });

  it('rejects a whitespace-only quote, including full-width spaces', () => {
    expect(gateQuote('三个平台改库存改到凌晨', ' \n\t\u3000 ')).toEqual({
      ok: false,
      reason: 'empty_quote',
    });
  });

  it('rejects quotes shorter than 4 or longer than 600 characters', () => {
    expect(gateQuote('三个平台改库存改到凌晨', '三个')).toEqual({
      ok: false,
      reason: 'empty_quote',
    });
    expect(gateQuote('三个平台改库存改到凌晨', '改'.repeat(601))).toEqual({
      ok: false,
      reason: 'empty_quote',
    });
  });

  it('rejects any quote when the snapshot is empty', () => {
    expect(gateQuote('', '三个平台改库存改到凌晨')).toEqual({
      ok: false,
      reason: 'quote_not_in_snapshot',
    });
  });

  it('never leaks the normalized text or its map on success or failure', () => {
    const success = gateQuote('甲乙\u3000\u3000丙丁', '甲乙 丙丁');
    const failure = gateQuote('甲乙丙丁', '戊己庚辛');

    expect(Object.keys(success).sort()).toEqual(['length', 'offset', 'ok']);
    expect(Object.keys(failure).sort()).toEqual(['ok', 'reason']);
  });
});

describe('normalizeForMatch', () => {
  it('folds NFKC, collapses whitespace and keeps a per-character map', () => {
    const { value, map } = normalizeForMatch('Ａ Ｂ\n\u3000Ｃ');

    expect(value).toBe('A B C');
    expect(map).toEqual([0, 1, 2, 3, 5]);
    expect(map).toHaveLength(value.length);
  });

  it('trims the edges and never maps a collapsed space to a later character', () => {
    const { value, map } = normalizeForMatch('  a  b  ');

    expect(value).toBe('a b');
    expect(map).toEqual([2, 3, 5]);
  });

  it('expands a ligature while keeping both characters mapped to its index', () => {
    const { value, map } = normalizeForMatch('成ﬁ本');

    expect(value).toBe('成fi本');
    expect(map).toEqual([0, 1, 1, 2]);
  });

  it('is monotonic and idempotent on already-normalized text', () => {
    const text = '甲\n乙\u3000丙 丁';
    const first = normalizeForMatch(text);
    const second = normalizeForMatch(first.value);

    expect(second.value).toBe(first.value);
    for (let index = 1; index < first.map.length; index += 1) {
      expect(first.map[index]).toBeGreaterThanOrEqual(first.map[index - 1] ?? 0);
    }
  });
});

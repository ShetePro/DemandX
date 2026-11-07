import { describe, expect, it } from 'vitest';

import {
  fingerprintFromText,
  fingerprintToText,
  isNovelFingerprint,
  opportunityFingerprint,
} from './novelty';

describe('opportunity novelty', () => {
  it('round-trips a fingerprint through JSON-safe text', () => {
    const fingerprint = opportunityFingerprint('跨境库存同步', '三个平台之间手工同步库存，经常超卖');
    expect(fingerprintFromText(fingerprintToText(fingerprint))).toBe(fingerprint);
  });

  it('treats a paraphrase of a stored direction as the same idea', () => {
    const original = opportunityFingerprint(
      '跨境库存同步',
      '卖家在三个平台之间手工同步库存，经常超卖',
    );
    const paraphrase = opportunityFingerprint(
      '多平台库存同步工具',
      '卖家在三个平台之间手工同步库存，经常超卖',
    );

    expect(isNovelFingerprint(paraphrase, [fingerprintToText(original)])).toBe(false);
  });

  it('accepts a genuinely different workflow', () => {
    const original = opportunityFingerprint('跨境库存同步', '卖家在三个平台之间手工同步库存，经常超卖');
    const different = opportunityFingerprint(
      '诊所排班',
      '牙科诊所的前台用 Excel 排班，换班全靠群里吼',
    );

    expect(isNovelFingerprint(different, [fingerprintToText(original)])).toBe(true);
  });

  it('ignores unreadable memory instead of blocking every idea', () => {
    const fingerprint = opportunityFingerprint('发票助手', '自由职业者每月手工汇总发票');
    expect(isNovelFingerprint(fingerprint, ['not-a-number'])).toBe(true);
    expect(fingerprintFromText('not-a-number')).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';

import {
  fingerprintFromText,
  fingerprintToText,
  ideaOverlap,
  ideaTokens,
  isNovelFingerprint,
  isRepeatedIdea,
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


describe('idea token overlap', () => {
  it('flags two wordings of the same workflow', () => {
    const first = ideaTokens('客服快捷回复工具', '客服每天在文档里找回复，重复且口吻不一');
    const second = ideaTokens('客服回复助手', '客服每天在文档里找回复，重复且口吻不一');
    expect(ideaOverlap(first, second)).toBeGreaterThanOrEqual(0.5);
    expect(isRepeatedIdea(second, [first])).toBe(true);
  });

  it('keeps a genuinely different workflow', () => {
    const scheduling = ideaTokens('门店排班表同步', '店长每天用 Excel 排班，换班全靠群里吼');
    const invoicing = ideaTokens('自由职业发票助手', '每月手工汇总发票，催客户付款很费劲');
    expect(isRepeatedIdea(invoicing, [scheduling])).toBe(false);
  });
});

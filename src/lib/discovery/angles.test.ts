import { describe, expect, it } from 'vitest';

import { resolvePlannedAngle } from './angles';

const PLANNED = ['诊所排班', '独立课程讲师备课', '外贸单据'];

describe('resolvePlannedAngle', () => {
  it('matches the planned label exactly', () => {
    expect(resolvePlannedAngle('诊所排班', PLANNED)).toBe('诊所排班');
  });

  it('accepts the shortened label a model echoes back', () => {
    expect(resolvePlannedAngle('独立课程讲师备课', PLANNED)).toBe('独立课程讲师备课');
    expect(resolvePlannedAngle('独立课程讲师备课：培训师拼装讲义', PLANNED)).toBe(
      '独立课程讲师备课',
    );
  });

  it('ignores punctuation and whitespace differences', () => {
    expect(resolvePlannedAngle(' 外贸 单据 ', PLANNED)).toBe('外贸单据');
  });

  it('rejects an angle this round never planned', () => {
    expect(resolvePlannedAngle('宠物美容预约', PLANNED)).toBeNull();
    expect(resolvePlannedAngle('   ', PLANNED)).toBeNull();
  });
});

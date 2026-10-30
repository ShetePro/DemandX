import { describe, expect, it } from 'vitest';

import { parseEvidenceFilters } from './filters';

describe('parseEvidenceFilters', () => {
  it('parses valid filters and trims them', () => {
    expect(
      parseEvidenceFilters({
        signal: 'paying',
        platform: ' xiaohongshu ',
        status: 'accepted',
        q: ' 库存 ',
      }),
    ).toEqual({ signal: 'paying', platform: 'xiaohongshu', status: 'accepted', q: '库存' });
  });

  it('takes the first value when the param repeats', () => {
    expect(parseEvidenceFilters({ signal: ['seeking', 'paying'] }).signal).toBe('seeking');
  });

  it('ignores unknown, blank and oversized values', () => {
    expect(
      parseEvidenceFilters({
        signal: 'unknown',
        platform: 'p'.repeat(61),
        status: 'pending',
        q: 'q'.repeat(101),
      }),
    ).toEqual({ signal: null, platform: null, status: null, q: null });

    expect(parseEvidenceFilters({ signal: '', platform: '   ' })).toEqual({
      signal: null,
      platform: null,
      status: null,
      q: null,
    });
  });

  it('returns all-null for an empty query object', () => {
    expect(parseEvidenceFilters({})).toEqual({
      signal: null,
      platform: null,
      status: null,
      q: null,
    });
  });
});

import { describe, expect, it } from 'vitest';

import { evidenceDraftSchema, evidenceExtractionSchema } from './schema';

const draft = {
  quote: '三个平台改库存改到凌晨两点',
  signal: 'problem' as const,
  firstHand: true,
  publishedAt: '2026-10-01T09:30:00Z',
  priceMentioned: { amount: 299, currency: 'CNY' },
  supports: '店主在人工同步三个平台的库存',
  doesNotProve: '不能证明他愿意为工具付费',
};

describe('evidenceDraftSchema', () => {
  it('accepts a complete draft', () => {
    expect(evidenceDraftSchema.safeParse(draft).success).toBe(true);
  });

  it('accepts null for the optional facts', () => {
    const parsed = evidenceDraftSchema.safeParse({
      ...draft,
      publishedAt: null,
      priceMentioned: null,
    });

    expect(parsed.success).toBe(true);
  });

  it('accepts the boundary quote lengths 4 and 600', () => {
    expect(evidenceDraftSchema.safeParse({ ...draft, quote: '太贵了吧' }).success).toBe(true);
    expect(evidenceDraftSchema.safeParse({ ...draft, quote: '改'.repeat(600) }).success).toBe(true);
  });

  it('rejects quotes shorter than 4 or longer than 600 characters', () => {
    expect(evidenceDraftSchema.safeParse({ ...draft, quote: '太贵' }).success).toBe(false);
    expect(evidenceDraftSchema.safeParse({ ...draft, quote: '改'.repeat(601) }).success).toBe(
      false,
    );
  });

  it('rejects an unknown signal', () => {
    expect(evidenceDraftSchema.safeParse({ ...draft, signal: 'demand' }).success).toBe(false);
    expect(evidenceDraftSchema.safeParse({ ...draft, signal: 'Paying' }).success).toBe(false);
  });

  it('rejects a price with a non-3-letter currency or a non-positive amount', () => {
    expect(
      evidenceDraftSchema.safeParse({
        ...draft,
        priceMentioned: { amount: 299, currency: 'RMBX' },
      }).success,
    ).toBe(false);
    expect(
      evidenceDraftSchema.safeParse({
        ...draft,
        priceMentioned: { amount: 299, currency: 'CN' },
      }).success,
    ).toBe(false);
    expect(
      evidenceDraftSchema.safeParse({
        ...draft,
        priceMentioned: { amount: 0, currency: 'CNY' },
      }).success,
    ).toBe(false);
  });

  it('rejects a non-ISO publishedAt and supports/doesNotProve over 120 characters', () => {
    expect(evidenceDraftSchema.safeParse({ ...draft, publishedAt: '2026-10-01' }).success).toBe(
      false,
    );
    expect(evidenceDraftSchema.safeParse({ ...draft, supports: '支'.repeat(121) }).success).toBe(
      false,
    );
    expect(
      evidenceDraftSchema.safeParse({ ...draft, doesNotProve: '不'.repeat(121) }).success,
    ).toBe(false);
  });
});

describe('evidenceExtractionSchema', () => {
  it('accepts an empty list and up to three items', () => {
    expect(evidenceExtractionSchema.safeParse({ items: [] }).success).toBe(true);
    expect(
      evidenceExtractionSchema.safeParse({
        items: [
          draft,
          { ...draft, quote: '第二个平台的库存也要手动改' },
          { ...draft, signal: 'paying' },
        ],
      }).success,
    ).toBe(true);
  });

  it('rejects more than three items', () => {
    expect(
      evidenceExtractionSchema.safeParse({
        items: [
          draft,
          { ...draft, quote: '第二个平台的库存也要手动改' },
          { ...draft, quote: '第三个平台的库存同样要手动改' },
          { ...draft, quote: '第四个平台的库存还得手动改' },
        ],
      }).success,
    ).toBe(false);
  });

  it('rejects a payload without an items array', () => {
    expect(evidenceExtractionSchema.safeParse({}).success).toBe(false);
    expect(evidenceExtractionSchema.safeParse({ items: draft }).success).toBe(false);
  });
});

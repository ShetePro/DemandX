import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { checkLabels, computeMetrics, matchQuote, type PageOutcome } from './extract-metrics';

function page(overrides: Partial<PageOutcome> & Pick<PageOutcome, 'text'>): PageOutcome {
  return {
    id: 'p1',
    expectedQuotes: [],
    acceptedQuotes: [],
    rejected: 0,
    ...overrides,
  };
}

describe('matchQuote', () => {
  it('matches an accepted quote longer than the label (same sentence, more context)', () => {
    const text = '前文。库存同步很慢，客服也不回。后文。';

    expect(matchQuote('库存同步很慢', '库存同步很慢，客服也不回', text)).toBe(true);
  });

  it('matches when the model returns a shorter span inside the label', () => {
    const text = '前文。库存同步很慢，客服也不回。后文。';

    expect(matchQuote('库存同步很慢，客服也不回', '库存同步很慢', text)).toBe(true);
  });

  it('matches across full-width letters and ideographic whitespace', () => {
    const text = '卖家说：“ＦＢＡ 真的断货了”。';

    expect(matchQuote('ＦＢＡ 真的断货了', 'FBA 真的断货了', text)).toBe(true);
    expect(matchQuote('ＦＢＡ 真的断货了', 'FBA\u3000真的断货了', text)).toBe(true);
  });

  it('does not match a paraphrase, even a close one', () => {
    const text = '前文。库存同步很慢，客服也不回。后文。';

    expect(matchQuote('库存同步很慢', '库存老是不同步', text)).toBe(false);
  });

  it('refuses an expectation that is not literally in the page', () => {
    // A label nobody can point at in the snapshot is a fixture bug, never a hit.
    expect(matchQuote('库存同步很慢', '库存同步很慢', '这句正文里没有那句话。')).toBe(false);
  });
});

describe('computeMetrics', () => {
  const text = '前文。库存同步很慢，客服也不回。后文。';

  it('reports recall 1 and precision 1 when every label is hit exactly', () => {
    const metrics = computeMetrics([
      page({
        text,
        expectedQuotes: ['库存同步很慢', '客服也不回'],
        acceptedQuotes: ['库存同步很慢', '客服也不回'],
      }),
      page({
        id: 'p2',
        text: '另一个页面。三个平台改库存改到凌晨。',
        expectedQuotes: ['三个平台改库存改到凌晨'],
        acceptedQuotes: ['三个平台改库存改到凌晨'],
        rejected: 2,
      }),
    ]);

    expect(metrics).toEqual({
      pages: 2,
      expected: 3,
      recalled: 3,
      precision: 1,
      recall: 1,
      rejected: 2,
    });
  });

  it('drops recall when one expected quote is missed', () => {
    const metrics = computeMetrics([
      page({
        text,
        expectedQuotes: ['库存同步很慢', '客服也不回'],
        acceptedQuotes: ['库存同步很慢'],
      }),
    ]);

    expect(metrics.expected).toBe(2);
    expect(metrics.recalled).toBe(1);
    expect(metrics.recall).toBe(0.5);
    expect(metrics.precision).toBe(1);
  });

  it('drops precision when the model extracts one extra unrelated quote', () => {
    const metrics = computeMetrics([
      page({
        text,
        expectedQuotes: ['库存同步很慢'],
        acceptedQuotes: ['库存同步很慢', '后文'],
      }),
    ]);

    expect(metrics.recall).toBe(1);
    expect(metrics.precision).toBe(0.5);
  });

  it('reports recall 0 when nothing the model extracted overlaps a label', () => {
    const metrics = computeMetrics([
      page({
        text,
        expectedQuotes: ['库存同步很慢'],
        acceptedQuotes: ['今天天气不错'],
      }),
    ]);

    expect(metrics.recall).toBe(0);
    expect(metrics.precision).toBe(0);
  });

  it('defines precision as 1 when the model accepted nothing', () => {
    // Nothing extracted means nothing false-positive; silence is punished by
    // recall, not by precision.
    const metrics = computeMetrics([
      page({ text, expectedQuotes: ['库存同步很慢'], acceptedQuotes: [], rejected: 1 }),
    ]);

    expect(metrics.precision).toBe(1);
    expect(metrics.recall).toBe(0);
    expect(metrics.rejected).toBe(1);
  });

  it('counts an expected quote once even when the model repeats it', () => {
    const metrics = computeMetrics([
      page({
        text,
        expectedQuotes: ['库存同步很慢'],
        acceptedQuotes: ['库存同步很慢', '库存同步很慢'],
      }),
    ]);

    expect(metrics.recalled).toBe(1);
    expect(metrics.expected).toBe(1);
    expect(metrics.recall).toBe(1);
    expect(metrics.precision).toBe(1);
  });

  it('does not match a quote against another page label', () => {
    const metrics = computeMetrics([
      page({ text, expectedQuotes: ['库存同步很慢'], acceptedQuotes: ['三个平台改库存改到凌晨'] }),
      page({
        id: 'p2',
        text: '另一个页面。三个平台改库存改到凌晨。',
        expectedQuotes: ['三个平台改库存改到凌晨'],
        acceptedQuotes: [],
      }),
    ]);

    expect(metrics.recalled).toBe(0);
    expect(metrics.precision).toBe(0);
  });
});

describe('checkLabels', () => {
  const text = '前文。库存同步很慢，客服也不回。后文。';

  it('accepts labels that are verbatim substrings', () => {
    expect(
      checkLabels([{ id: 'p1', text, expectedQuotes: ['库存同步很慢', '客服也不回'] }]),
    ).toEqual([]);
  });

  it('flags a quote the page does not contain', () => {
    expect(checkLabels([{ id: 'p1', text, expectedQuotes: ['库存老是不同步'] }])).toEqual([
      { pageId: 'p1', quote: '库存老是不同步', reason: 'quote_not_in_text' },
    ]);
  });

  it('flags duplicate quotes, short quotes and empty labels', () => {
    const issues = checkLabels([
      { id: 'p1', text, expectedQuotes: ['库存同步很慢', '库存同步很慢'] },
      { id: 'p2', text: '另一页。库存同步很慢。', expectedQuotes: ['库存同步很慢'] },
      { id: 'p3', text, expectedQuotes: ['很短'] },
      { id: 'p4', text, expectedQuotes: [] },
      { id: 'p5', text: '   ', expectedQuotes: ['库存同步很慢'] },
    ]);

    expect(issues.map((issue) => `${issue.pageId}:${issue.reason}`)).toEqual([
      'p1:duplicate_quote',
      'p2:duplicate_quote',
      'p3:quote_too_short',
      'p4:no_expected',
      'p5:empty_text',
      'p5:duplicate_quote',
    ]);
  });
});

describe('labeled fixture', () => {
  const fixtureSchema = z.object({
    pages: z
      .array(
        z.object({
          id: z.string().min(1),
          text: z.string().min(1),
          expectedQuotes: z.array(z.string()).min(1),
        }),
      )
      .min(1),
  });

  const fixture = fixtureSchema.parse(
    JSON.parse(
      readFileSync(
        new URL('../../../tests/fixtures/extract/labeled.json', import.meta.url),
        'utf8',
      ),
    ),
  );

  it('is self-consistent: every quote is verbatim in its page', () => {
    expect(checkLabels(fixture.pages)).toEqual([]);
  });

  it('keeps pages short enough for one extraction call and 1–2 labels each', () => {
    expect(fixture.pages).toHaveLength(12);
    for (const labeled of fixture.pages) {
      expect(labeled.text.length).toBeLessThanOrEqual(1500);
      expect(labeled.expectedQuotes.length).toBeGreaterThanOrEqual(1);
      expect(labeled.expectedQuotes.length).toBeLessThanOrEqual(2);
    }
  });
});

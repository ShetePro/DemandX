import { describe, expect, it } from 'vitest';

import {
  HIGHLIGHT_AFTER_CHARS,
  HIGHLIGHT_BEFORE_CHARS,
  HIGHLIGHT_QUOTE_CHARS,
  sliceQuoteHighlight,
} from './highlight';

describe('sliceQuoteHighlight', () => {
  it('cuts before/quote/after at the stored offset', () => {
    const text = 'AAAA 我在三个平台之间手工同步库存。 BBBB';
    const quote = '我在三个平台之间手工同步库存。';
    const offset = text.indexOf(quote);

    expect(sliceQuoteHighlight(text, offset, quote)).toEqual({
      before: 'AAAA ',
      quote,
      after: ' BBBB',
    });
  });

  it('caps the context and the quote instead of sending the whole page', () => {
    const quote = 'q'.repeat(HIGHLIGHT_QUOTE_CHARS + 50);
    const text =
      'a'.repeat(HIGHLIGHT_BEFORE_CHARS + 10) + quote + 'b'.repeat(HIGHLIGHT_AFTER_CHARS + 10);
    const offset = HIGHLIGHT_BEFORE_CHARS + 10;

    const highlight = sliceQuoteHighlight(text, offset, quote);

    expect(highlight.before).toHaveLength(HIGHLIGHT_BEFORE_CHARS);
    expect(highlight.quote).toHaveLength(HIGHLIGHT_QUOTE_CHARS);
    expect(highlight.after).toHaveLength(HIGHLIGHT_AFTER_CHARS);
  });

  it('falls back to the stored quote when the offset is past the end', () => {
    expect(sliceQuoteHighlight('short', 99, '原文引用')).toEqual({
      before: 'short',
      quote: '原文引用',
      after: '',
    });
  });
});

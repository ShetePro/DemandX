/** Bytes of surrounding context sent to the browser, never the whole page. */
export const HIGHLIGHT_BEFORE_CHARS = 200;
export const HIGHLIGHT_QUOTE_CHARS = 600;
export const HIGHLIGHT_AFTER_CHARS = 200;

export interface QuoteHighlight {
  before: string;
  quote: string;
  after: string;
}

/**
 * Cut the stored snapshot around a quote using its real `quote_offset`.
 *
 * Only the three fragments ever leave the server; the browser never receives
 * the full page. The quote is taken from the snapshot at the stored offset, so
 * a highlight cannot drift away from the text it claims to mark. If the offset
 * lands past the end (a corrupt row), the row's own quote is shown without
 * context instead of an empty mark.
 */
export function sliceQuoteHighlight(text: string, offset: number, quote: string): QuoteHighlight {
  const start = Math.min(Math.max(offset, 0), text.length);
  const end = Math.min(start + quote.length, start + HIGHLIGHT_QUOTE_CHARS);
  const original = text.slice(start, end);

  return {
    before: text.slice(Math.max(0, start - HIGHLIGHT_BEFORE_CHARS), start),
    quote: original === '' ? quote.slice(0, HIGHLIGHT_QUOTE_CHARS) : original,
    after: text.slice(end, end + HIGHLIGHT_AFTER_CHARS),
  };
}

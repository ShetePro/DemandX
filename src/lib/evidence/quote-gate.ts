import { MAX_QUOTE_LENGTH, MIN_QUOTE_LENGTH } from './schema';

/**
 * Why a quote was refused. `empty_quote` also covers a quote outside the
 * accepted length band, because both mean "nothing usable was extracted".
 */
export type GateFailureReason = 'empty_quote' | 'quote_not_in_snapshot';

/**
 * `offset`/`length` always address the **original** snapshot text so the UI can
 * highlight it; neither the normalized text nor its map ever leaves this module.
 */
export type GateResult =
  { ok: true; offset: number; length: number } | { ok: false; reason: GateFailureReason };

/** `\s` covers newlines, tabs, NBSP and the ideographic space (U+3000). */
const WHITESPACE_ONLY = /^\s+$/u;

/**
 * NFKC-folds `text` and collapses every whitespace run to one ASCII space,
 * while remembering where each resulting character came from.
 *
 * `map[i]` is the UTF-16 index in `text` of the character that produced
 * `value[i]`. Leading and trailing whitespace is dropped, so a match can never
 * start or end on padding. `map` has the same length as `value`.
 */
export function normalizeForMatch(text: string): { value: string; map: number[] } {
  let value = '';
  const map: number[] = [];
  let pendingSpace = false;
  let pendingSpaceIndex = 0;
  let seenText = false;

  let index = 0;
  for (const char of text) {
    const originalIndex = index;
    index += char.length;
    const folded = char.normalize('NFKC');
    if (folded === '') continue;

    if (WHITESPACE_ONLY.test(folded)) {
      if (seenText && !pendingSpace) {
        pendingSpace = true;
        pendingSpaceIndex = originalIndex;
      }
      continue;
    }

    if (pendingSpace) {
      value += ' ';
      map.push(pendingSpaceIndex);
      pendingSpace = false;
    }
    seenText = true;
    value += folded;
    for (let unit = 0; unit < folded.length; unit += 1) map.push(originalIndex);
  }

  return { value, map };
}

/**
 * The only two ways a quote may enter the evidence store: it is an exact
 * substring of the snapshot, or it is one after whitespace folding and NFKC.
 * Paraphrases, synonyms, typo fixes and edit-distance matches are rejected by
 * design — a quote the model rewrote is a fabricated quote.
 */
export function gateQuote(snapshotText: string, quote: string): GateResult {
  const trimmed = quote.trim();
  if (trimmed.length < MIN_QUOTE_LENGTH || trimmed.length > MAX_QUOTE_LENGTH) {
    return { ok: false, reason: 'empty_quote' };
  }

  const exactOffset = snapshotText.indexOf(quote);
  if (exactOffset !== -1) {
    return { ok: true, offset: exactOffset, length: quote.length };
  }

  const snapshot = normalizeForMatch(snapshotText);
  const normalizedQuote = normalizeForMatch(quote).value;
  if (normalizedQuote === '') return { ok: false, reason: 'quote_not_in_snapshot' };

  const start = snapshot.value.indexOf(normalizedQuote);
  if (start === -1) return { ok: false, reason: 'quote_not_in_snapshot' };

  const end = start + normalizedQuote.length;
  const first = snapshot.map[start];
  const last = snapshot.map[end - 1];
  if (first === undefined || last === undefined) {
    return { ok: false, reason: 'quote_not_in_snapshot' };
  }

  return { ok: true, offset: first, length: last - first + 1 };
}

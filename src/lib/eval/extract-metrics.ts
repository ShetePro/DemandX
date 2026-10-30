import { MAX_QUOTE_LENGTH, MIN_QUOTE_LENGTH } from '@/lib/evidence/schema';
import { normalizeForMatch } from '@/lib/evidence/quote-gate';

/**
 * One labeled page: the snapshot text an extraction call reads, plus the
 * quotes a human judged to be the evidence on that page. `text` is inline so a
 * reviewer can check a label without opening the original snapshot.
 */
export interface LabeledPage {
  id: string;
  text: string;
  expectedQuotes: string[];
}

/** What one page produced after the model answered and the gate judged it. */
export interface PageOutcome {
  id: string;
  text: string;
  expectedQuotes: string[];
  /** Quotes the gate accepted, i.e. found in the snapshot within length bounds. */
  acceptedQuotes: string[];
  /** Candidates the gate refused (`empty_quote` / `quote_not_in_snapshot`). */
  rejected: number;
}

export interface Metrics {
  /** Pages that were evaluated, including pages whose LLM call failed. */
  pages: number;
  /** Total expected quotes across those pages. */
  expected: number;
  /** Expected quotes that at least one accepted quote covers. Counted once each. */
  recalled: number;
  /** Accepted quotes matching any expected quote on the same page, over all accepted. */
  precision: number;
  /** `recalled / expected`; 1 when a page has no labels (only tests reach that). */
  recall: number;
  /** Candidates the gate refused. */
  rejected: number;
}

export type LabelIssueReason =
  | 'empty_text'
  | 'no_expected'
  | 'quote_too_short'
  | 'quote_too_long'
  | 'quote_not_in_text'
  | 'duplicate_quote';

/** One reason a fixture cannot be used as a ground truth. */
export interface LabelIssue {
  pageId: string;
  quote: string | null;
  reason: LabelIssueReason;
}

/**
 * The comparison is deliberately looser than the gate but never semantic:
 * quotes are NFKC-folded and whitespace-collapsed, then one must contain the
 * other. So a model that copies a longer span around the labeled sentence still
 * recalls it, while a paraphrase, a synonym or a typo fix does not match.
 *
 * `snapshotText` is the label's own justification: an expectation that is not
 * literally in the page cannot be evidence, so it never matches (and
 * `checkLabels` reports it as a fixture bug before any model call).
 */
export function matchQuote(expected: string, accepted: string, snapshotText: string): boolean {
  if (!snapshotText.includes(expected)) return false;

  const want = normalizeForMatch(expected).value;
  const got = normalizeForMatch(accepted).value;
  if (want === '' || got === '') return false;

  return got.includes(want) || want.includes(got);
}

/**
 * Aggregates page outcomes. Two conventions make the numbers readable:
 *
 * - An expected quote is counted at most once, so the model returning the same
 *   sentence twice cannot push recall above 1.
 * - With no accepted quote there is nothing that could be a false positive, so
 *   precision is 1 — silence is punished by recall, not by precision.
 */
export function computeMetrics(outcomes: readonly PageOutcome[]): Metrics {
  let expected = 0;
  let recalled = 0;
  let accepted = 0;
  let matched = 0;
  let rejected = 0;

  for (const page of outcomes) {
    for (const want of page.expectedQuotes) {
      expected += 1;
      if (page.acceptedQuotes.some((got) => matchQuote(want, got, page.text))) recalled += 1;
    }

    for (const got of page.acceptedQuotes) {
      accepted += 1;
      if (page.expectedQuotes.some((want) => matchQuote(want, got, page.text))) matched += 1;
    }

    rejected += page.rejected;
  }

  return {
    pages: outcomes.length,
    expected,
    recalled,
    precision: accepted === 0 ? 1 : matched / accepted,
    recall: expected === 0 ? 1 : recalled / expected,
    rejected,
  };
}

/**
 * Fixture self-check. Every expectation must be a verbatim substring of its
 * page and inside the gate's length band, otherwise the harness would measure
 * itself instead of the model. Duplicates count as bugs: they inflate `expected`
 * without adding a distinct fact.
 */
export function checkLabels(pages: readonly LabeledPage[]): LabelIssue[] {
  const issues: LabelIssue[] = [];
  const seen = new Set<string>();

  for (const page of pages) {
    if (page.text.trim() === '') {
      issues.push({ pageId: page.id, quote: null, reason: 'empty_text' });
    }
    if (page.expectedQuotes.length === 0) {
      issues.push({ pageId: page.id, quote: null, reason: 'no_expected' });
    }

    for (const quote of page.expectedQuotes) {
      const trimmed = quote.trim();
      if (seen.has(trimmed)) {
        issues.push({ pageId: page.id, quote, reason: 'duplicate_quote' });
        continue;
      }
      seen.add(trimmed);

      if (trimmed.length < MIN_QUOTE_LENGTH) {
        issues.push({ pageId: page.id, quote, reason: 'quote_too_short' });
        continue;
      }
      if (trimmed.length > MAX_QUOTE_LENGTH) {
        issues.push({ pageId: page.id, quote, reason: 'quote_too_long' });
        continue;
      }
      if (!page.text.includes(quote)) {
        issues.push({ pageId: page.id, quote, reason: 'quote_not_in_text' });
      }
    }
  }

  return issues;
}

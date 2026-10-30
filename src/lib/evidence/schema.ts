import { z } from 'zod';

/**
 * The five signal classes, in `signalEnum`'s order. They are graded separately
 * and never merged: a page that shows a problem is not evidence of payment.
 */
export const SIGNALS = ['problem', 'seeking', 'paying', 'switching', 'recurring'] as const;

export type Signal = (typeof SIGNALS)[number];

/** Quote bounds shared by the extraction schema and the quote gate. */
export const MIN_QUOTE_LENGTH = 4;
export const MAX_QUOTE_LENGTH = 600;

/** A page contributes at most three quotes; more is a sign of padding. */
export const MAX_ITEMS_PER_PAGE = 3;

/**
 * One candidate evidence row as the LLM emits it. Every field is a claim that
 * the quote gate or the operator can check against the snapshot: `quote` must
 * be copied verbatim, and `doesNotProve` is mandatory so one sentence can never
 * be stretched into a market conclusion.
 */
export const evidenceDraftSchema = z.object({
  quote: z.string().min(MIN_QUOTE_LENGTH).max(MAX_QUOTE_LENGTH),
  signal: z.enum(SIGNALS),
  firstHand: z.boolean(),
  publishedAt: z.iso.datetime().nullable(),
  priceMentioned: z
    .object({
      amount: z.number().positive(),
      currency: z.string().length(3),
    })
    .nullable(),
  supports: z.string().min(4).max(120),
  doesNotProve: z.string().min(4).max(120),
});

export type EvidenceDraft = z.infer<typeof evidenceDraftSchema>;

/** What one extraction call returns for one page. An empty list is valid. */
export const evidenceExtractionSchema = z.object({
  items: z.array(evidenceDraftSchema).max(MAX_ITEMS_PER_PAGE),
});

export type EvidenceExtraction = z.infer<typeof evidenceExtractionSchema>;

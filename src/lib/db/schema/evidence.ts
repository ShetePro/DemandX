import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { runs } from './core';

/**
 * The five signal classes of README — graded separately, never merged:
 * problem exists → actively seeking → already paying → willing to switch →
 * able to keep paying.
 */
export const signalEnum = pgEnum('signal', [
  'problem',
  'seeking',
  'paying',
  'switching',
  'recurring',
]);

/** Search queries issued by the collection stage, kept for auditability. */
export const queries = pgTable('queries', {
  id: serial('id').primaryKey(),
  runId: integer('run_id')
    .notNull()
    .references(() => runs.id, { onDelete: 'cascade' }),
  angle: text('angle'),
  provider: text('provider'),
  text: text('text'),
  resultCount: integer('result_count').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

/**
 * A fetched page. Identity is `(canonical_url, content_hash)`: the same URL
 * may legitimately be re-crawled when its content changes, and each snapshot
 * backs the quotes extracted from it.
 */
export const sources = pgTable(
  'sources',
  {
    id: serial('id').primaryKey(),
    runId: integer('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    canonicalUrl: text('canonical_url').notNull(),
    platform: text('platform').notNull(),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }),
    contentHash: text('content_hash').notNull(),
    snapshotPath: text('snapshot_path'),
    httpStatus: integer('http_status'),
    crawlTier: text('crawl_tier'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('sources_canonical_url_content_hash_key').on(t.canonicalUrl, t.contentHash),
    index('sources_canonical_url_idx').on(t.canonicalUrl),
  ],
);

/**
 * The only market fact an LLM is allowed to emit. `quote` must be an exact
 * substring of the referenced snapshot; `does_not_prove` states the limit of
 * what it supports. Rejected candidates are kept with a reason.
 */
export const evidence = pgTable(
  'evidence',
  {
    id: serial('id').primaryKey(),
    runId: integer('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    sourceId: integer('source_id')
      .notNull()
      .references(() => sources.id, { onDelete: 'cascade' }),
    quote: text('quote').notNull(),
    quoteOffset: integer('quote_offset'),
    platform: text('platform').notNull(),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    signal: signalEnum('signal').notNull(),
    firstHand: boolean('first_hand').notNull().default(false),
    priceMentioned: jsonb('price_mentioned'),
    supports: text('supports'),
    doesNotProve: text('does_not_prove'),
    rejectedReason: text('rejected_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('evidence_run_id_signal_idx').on(t.runId, t.signal),
    // Re-running extraction must not duplicate a verdict: the same quote from
    // the same source is one fact, accepted or rejected.
    uniqueIndex('evidence_run_id_source_id_quote_key').on(t.runId, t.sourceId, t.quote),
  ],
);

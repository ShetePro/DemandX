import { integer, jsonb, pgTable, serial, text, timestamp } from 'drizzle-orm/pg-core';

import { threads } from './core';

/**
 * One completed radar scan. The row is the radar's memory: the next scan reads
 * the queries and angles it must not repeat, the source URLs it must exclude,
 * and the opportunity fingerprints it must not hand back under a new title.
 */
export const discoveryScans = pgTable('discovery_scans', {
  id: serial('id').primaryKey(),
  /** Angles the planner chose; `通用业务手工痛点` when the planner fell back. */
  angles: jsonb('angles').$type<string[]>().notNull(),
  queries: jsonb('queries').$type<string[]>().notNull(),
  /** Snippets shown to the analysis model, replayable after the fact. */
  sourceUrls: jsonb('source_urls').$type<string[]>().notNull(),
  /** `{title, problem, angle, fingerprint}` per opportunity, for novelty tests. */
  opportunities: jsonb('opportunities')
    .$type<{ title: string; problem: string; angle: string; fingerprint: string }[]>()
    .notNull(),
  /** Trend headlines that steered this scan, so a repeat can be explained. */
  trendTitles: jsonb('trend_titles').$type<string[]>().notNull(),
  /** `planned` = the model chose the angles, `fallback` = the static pool did. */
  strategy: text('strategy').notNull(),
  model: text('model'),
  elapsedMs: integer('elapsed_ms').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

/**
 * A discovered direction the operator actually started researching. This is
 * the only learning signal the radar trusts: it says which angles to deepen
 * and which to stop regenerating.
 */
export const discoveryFeedback = pgTable('discovery_feedback', {
  id: serial('id').primaryKey(),
  // Historical: the feedback outlives the scan row it describes.
  scanId: integer('scan_id').references(() => discoveryScans.id, { onDelete: 'set null' }),
  opportunityTitle: text('opportunity_title').notNull(),
  angle: text('angle'),
  threadId: integer('thread_id').references(() => threads.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

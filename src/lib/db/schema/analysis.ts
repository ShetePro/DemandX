import { sql } from 'drizzle-orm';
import {
  check,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';
import { runs } from './core';

/**
 * A clustered opportunity inside one run. `independent_sources` counts
 * distinct sources, which is what separates a real signal from one loud thread;
 * `evidence_ids` lists the evidence rows that backed the cluster.
 */
export const opportunities = pgTable('opportunities', {
  id: serial('id').primaryKey(),
  runId: integer('run_id')
    .notNull()
    .references(() => runs.id, { onDelete: 'cascade' }),
  name: text('name'),
  positioning: text('positioning'),
  independentSources: integer('independent_sources').notNull().default(0),
  evidenceIds: integer('evidence_ids')
    .array()
    .notNull()
    .default(sql`'{}'::integer[]`),
});

/**
 * One rubric dimension of one opportunity. Scoring lives in code, not in the
 * LLM, so the range is enforced by the database: a single dimension caps at 20.
 */
export const scores = pgTable(
  'scores',
  {
    opportunityId: integer('opportunity_id')
      .notNull()
      .references(() => opportunities.id, { onDelete: 'cascade' }),
    dimension: text('dimension').notNull(),
    points: integer('points').notNull(),
    rationale: text('rationale'),
    evidenceIds: integer('evidence_ids')
      .array()
      .default(sql`'{}'::integer[]`),
  },
  (t) => [
    primaryKey({ columns: [t.opportunityId, t.dimension] }),
    check('scores_points_range_check', sql`${t.points} between 0 and 20`),
  ],
);

/** One report per run; `unknowns` records what the evidence did not establish. */
export const reports = pgTable(
  'reports',
  {
    id: serial('id').primaryKey(),
    runId: integer('run_id')
      .notNull()
      .unique()
      .references(() => runs.id, { onDelete: 'cascade' }),
    sections: jsonb('sections').notNull(),
    rubricTotal: integer('rubric_total').notNull(),
    credibilityGrade: text('credibility_grade').notNull(),
    decision: text('decision').notNull(),
    unknowns: jsonb('unknowns').default(sql`'[]'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    check('reports_credibility_grade_check', sql`${t.credibilityGrade} in ('A', 'B', 'C', 'D')`),
  ],
);

/**
 * Which evidence backs which report claim, addressed by JSON path
 * (e.g. `part2.evidence[3].claim`). Deliberately no FK to `evidence`: the
 * citation trail must survive evidence being deleted, so `evidence_id` is
 * recorded as a historical reference only.
 */
export const citations = pgTable(
  'citations',
  {
    reportId: integer('report_id')
      .notNull()
      .references(() => reports.id, { onDelete: 'cascade' }),
    reportPath: text('report_path').notNull(),
    evidenceId: integer('evidence_id').notNull(),
  },
  (t) => [primaryKey({ columns: [t.reportId, t.reportPath] })],
);

import { boolean, integer, pgTable, serial, text, timestamp } from 'drizzle-orm/pg-core';
import { runs } from './core';

/**
 * The 14-day validation plan attached to a run. `evidence_id` is a plain
 * reference (no FK) so a completed task keeps pointing at the evidence it was
 * closed against even if that row is later pruned.
 */
export const validationTasks = pgTable('validation_tasks', {
  id: serial('id').primaryKey(),
  runId: integer('run_id')
    .notNull()
    .references(() => runs.id, { onDelete: 'cascade' }),
  day: integer('day').notNull(),
  title: text('title').notNull(),
  done: boolean('done').default(false),
  evidenceId: integer('evidence_id'),
  note: text('note'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

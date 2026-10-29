import { sql } from 'drizzle-orm';
import {
  bigserial,
  check,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/**
 * Chat layer: an idea is the user's raw pitch, a thread is one conversation
 * about it, a message is one turn of that conversation.
 */
export const ideas = pgTable('ideas', {
  id: serial('id').primaryKey(),
  title: text('title').notNull(),
  rawInput: text('raw_input').notNull(),
  constraints: jsonb('constraints'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const threads = pgTable('threads', {
  id: serial('id').primaryKey(),
  ideaId: integer('idea_id')
    .notNull()
    .references(() => ideas.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const messages = pgTable(
  'messages',
  {
    id: serial('id').primaryKey(),
    threadId: integer('thread_id')
      .notNull()
      .references(() => threads.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
    parts: jsonb('parts').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [check('messages_role_check', sql`${t.role} in ('user', 'assistant', 'system')`)],
);

/**
 * Pipeline layer: a run is one investigation of an idea. `chain_snapshot`
 * freezes the LLM chain used, `error` holds the structured failure if any.
 * `thread_id` is SET NULL so a run survives its conversation being deleted.
 */
export const runs = pgTable('runs', {
  id: serial('id').primaryKey(),
  ideaId: integer('idea_id')
    .notNull()
    .references(() => ideas.id, { onDelete: 'cascade' }),
  threadId: integer('thread_id').references(() => threads.id, { onDelete: 'set null' }),
  status: text('status').notNull().default('queued'),
  stage: text('stage'),
  deadlineAt: timestamp('deadline_at', { withTimezone: true }),
  chainSnapshot: jsonb('chain_snapshot'),
  startedAt: timestamp('started_at', { withTimezone: true }),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  error: jsonb('error'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

/**
 * Append-only log driving the SSE stream; `seq` is the client's resume cursor,
 * so `(run_id, seq)` must be unique per run.
 */
export const runEvents = pgTable(
  'run_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    runId: integer('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    type: text('type').notNull(),
    payload: jsonb('payload')
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex('run_events_run_id_seq_key').on(t.runId, t.seq)],
);

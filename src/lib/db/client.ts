import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

export type Database = PostgresJsDatabase<typeof schema>;

type DbHandle = { db: Database; sql: postgres.Sql };

// Next.js dev mode re-evaluates modules on every hot update; caching the handle
// on `globalThis` keeps a single pool for the lifetime of the process.
const globalForDb = globalThis as typeof globalThis & { __demandxDb?: DbHandle };

function createHandle(): DbHandle {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set. Copy .env.example to .env and start the local database with `docker compose up -d`.',
    );
  }

  const sql = postgres(url, { max: 10 });
  return { db: drizzle(sql, { schema }), sql };
}

const handle = (globalForDb.__demandxDb ??= createHandle());

/** Drizzle client bound to the full schema. */
export const db = handle.db;

/** Raw postgres.js client, for `sql` templates and lifecycle control. */
export const sql = handle.sql;

/** Drain the pool. Safe to call once per process (used by scripts). */
export async function closeDb(): Promise<void> {
  await sql.end({ timeout: 5 });
  delete globalForDb.__demandxDb;
}

import fs from 'node:fs';
import path from 'node:path';
import postgres from 'postgres';

/**
 * Direct housekeeping for the E2E suites. Tests drive the real UI for every
 * behaviour; the database connection is only used to seed rows a suite cannot
 * create yet (run events before the worker lands) and to prove the suite left
 * the shared `demandx` database as it found it.
 */

let sql: postgres.Sql | null = null;

export function databaseUrl(): string {
  const configured = process.env.DATABASE_URL?.trim();
  if (configured) return configured;

  const envFile = path.join(process.cwd(), '.env');
  const line = fs
    .readFileSync(envFile, 'utf8')
    .split(/\r?\n/)
    .find((entry) => entry.trimStart().startsWith('DATABASE_URL='));

  if (line) {
    const value = line
      .slice(line.indexOf('=') + 1)
      .trim()
      .replace(/^["']|["']$/g, '');
    if (value !== '') return value;
  }

  throw new Error('DATABASE_URL 未配置：请准备 .env（参考 .env.example）后重试');
}

export function db(): postgres.Sql {
  if (sql === null) sql = postgres(databaseUrl(), { max: 1 });
  return sql;
}

/** Close the shared connection so the Playwright worker can exit cleanly. */
export async function closeDb(): Promise<void> {
  if (sql === null) return;
  await sql.end({ timeout: 5 });
  sql = null;
}

/**
 * Remove every provider whose name matches the LIKE pattern. Chain rows go
 * first: `llm_chains.provider_id` is ON DELETE RESTRICT, so a provider that is
 * still wired into a chain cannot be removed before its rows are.
 *
 * The pattern is scoped to one suite (`e2e-stub%`, `e2e-chat%`) so a parallel
 * suite's fixtures are never deleted from under it.
 */
export async function purgeProvidersByPrefix(prefix: string): Promise<number> {
  const client = db();
  await client`
    delete from llm_chains
    where provider_id in (select id from providers where name like ${prefix})
  `;
  const removed = await client<{ id: number }[]>`
    delete from providers where name like ${prefix} returning id
  `;
  return removed.length;
}

export async function countProviderRows(
  prefix: string,
): Promise<{ providers: number; chainRows: number }> {
  const client = db();
  const providerRows = await client<{ count: number }[]>`
    select count(*)::int as count from providers where name like ${prefix}
  `;
  const chainRows = await client<{ count: number }[]>`
    select count(*)::int as count
    from llm_chains
    where provider_id in (select id from providers where name like ${prefix})
  `;
  return {
    providers: providerRows[0]?.count ?? -1,
    chainRows: chainRows[0]?.count ?? -1,
  };
}

/**
 * Delete the conversations a suite created. Removing the idea cascades through
 * `threads`, `messages` and the thread's `runs` (+ `run_events`), so one
 * statement cleans the whole tree without relying on the order of the FKs.
 */
export async function deleteThreadsWithIdeas(threadIds: readonly number[]): Promise<void> {
  if (threadIds.length === 0) return;
  const client = db();
  await client`
    delete from ideas
    where id in (select idea_id from threads where id in ${client([...threadIds])})
  `;
}

export async function countThreadArtifacts(
  threadIds: readonly number[],
): Promise<{ threads: number; runs: number; messages: number }> {
  if (threadIds.length === 0) return { threads: 0, runs: 0, messages: 0 };

  const client = db();
  const rows = await client<{ threads: number; runs: number; messages: number }[]>`
    select
      (select count(*)::int from threads where id in ${client([...threadIds])}) as threads,
      (select count(*)::int from runs where thread_id in ${client([...threadIds])}) as runs,
      (select count(*)::int from messages where thread_id in ${client([...threadIds])}) as messages
  `;
  return rows[0] ?? { threads: -1, runs: -1, messages: -1 };
}

/**
 * Every stored turn of one thread, oldest first. A streaming reply reaches the
 * page before it reaches Postgres, so a spec that reloads asserts on this row
 * instead of on the DOM and a timeout.
 */
export async function storedMessages(
  threadId: number,
): Promise<{ role: string; parts: unknown }[]> {
  const rows = await db()<{ role: string; parts: unknown }[]>`
    select role, parts from messages where thread_id = ${threadId} order by created_at, id
  `;
  return rows.map((row) => ({ role: row.role, parts: row.parts }));
}

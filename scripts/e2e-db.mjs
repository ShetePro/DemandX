import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

/**
 * Recreates the E2E database before the server starts. It must run before
 * `next start`, because the webServer readiness probe renders pages that read
 * from the database.
 */
const url = process.env.DATABASE_URL ?? 'postgres://demandx:demandx@127.0.0.1:5433/demandx_e2e';
const database = new URL(url).pathname.replace(/^\//, '');
if (!database.endsWith('_e2e')) {
  throw new Error(`拒绝在非 _e2e 数据库上运行：${database}`);
}

const adminUrl = new URL(url);
adminUrl.pathname = '/postgres';
const admin = postgres(adminUrl.toString(), { max: 1 });
await admin.unsafe(`drop database if exists "${database}" with (force)`);
await admin.unsafe(`create database "${database}"`);
await admin.end();

const sql = postgres(url, { max: 1 });
await migrate(drizzle(sql), { migrationsFolder: './drizzle' });
await sql.end();
console.log(`e2e database ready: ${database}`);

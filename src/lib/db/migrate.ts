import { readFileSync } from 'node:fs';
import path from 'node:path';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { closeDb, db } from './client';

const migrationsFolder = path.join(process.cwd(), 'drizzle');
const journalPath = path.join(migrationsFolder, 'meta', '_journal.json');

type Journal = { entries: { tag: string }[] };

function countMigrations(): number {
  try {
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as Journal;
    return journal.entries.length;
  } catch {
    return 0;
  }
}

async function main(): Promise<void> {
  const total = countMigrations();
  if (total === 0) {
    throw new Error(`No migrations found at ${migrationsFolder}. Run \`pnpm db:generate\` first.`);
  }

  // drizzle's migrator records applied migrations in `drizzle.__drizzle_migrations`
  // and skips those already present, so re-running this is a no-op.
  await migrate(db, { migrationsFolder });

  console.log(`✅ migrations applied — ${total} in journal (${migrationsFolder})`);
}

main()
  .catch((error: unknown) => {
    console.error('❌ migration failed');
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb();
  });

import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { closeDb, getDb } from './client';

export const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations');

export async function runMigrations(url = process.env.DATABASE_URL): Promise<void> {
  await migrate(getDb(url), { migrationsFolder: MIGRATIONS_DIR });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  runMigrations()
    .then(() => console.log('migrations applied'))
    .catch((e) => {
      console.error('migration failed:', e instanceof Error ? e.message : e);
      process.exitCode = 1;
    })
    .finally(() => closeDb());
}

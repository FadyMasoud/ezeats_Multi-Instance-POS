import '../load-env';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Client } from 'pg';

/** Arbitrary constant; serializes concurrent migration runs (e.g. two containers starting). */
const MIGRATION_LOCK_KEY = 727_001;

export async function runMigrations(databaseUrl: string): Promise<void> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    await migrate(drizzle(client), { migrationsFolder: join(__dirname, '..', '..', 'drizzle') });
  } finally {
    await client
      .query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY])
      .catch(() => undefined);
    await client.end();
  }
}

if (require.main === module) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }
  runMigrations(url)
    .then(() => console.log('migrations applied'))
    .catch((error: unknown) => {
      console.error(error);
      process.exit(1);
    });
}

import { resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { Client } from 'pg';
import { runMigrations } from '../../apps/api/src/db/migrate';

/** Rebuilds the test database schema from the generated migrations before the suite runs. */
export default async function setup(): Promise<void> {
  loadDotenv({ path: resolve(__dirname, '..', '..', '.env') });
  const url = process.env.TEST_DATABASE_URL;
  if (!url)
    throw new Error('TEST_DATABASE_URL is required for integration tests (see .env.example)');
  if (url === process.env.DATABASE_URL) {
    throw new Error('TEST_DATABASE_URL must not point at the development database');
  }

  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query('DROP SCHEMA IF EXISTS public CASCADE');
    await client.query('DROP SCHEMA IF EXISTS drizzle CASCADE');
    await client.query('CREATE SCHEMA public');
  } finally {
    await client.end();
  }
  await runMigrations(url);
}

import { type NodePgDatabase, drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema';

export type Database = NodePgDatabase<typeof schema>;
/** A Drizzle transaction handle; same query API as Database. */
export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

export const DB = Symbol('DB');
export const PG_POOL = Symbol('PG_POOL');

export function createPool(connectionString: string, max = 10): Pool {
  return new Pool({ connectionString, max, application_name: 'ezeats-api' });
}

export function createDatabase(pool: Pool): Database {
  return drizzle(pool, { schema });
}

import { type NodePgDatabase, drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema';

export type Database = NodePgDatabase<typeof schema>;
/** A Drizzle transaction handle; same query API as Database. */
export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

/** Connection pool for HTTP request handling. */
export const DB = Symbol('DB');
export const PG_POOL = Symbol('PG_POOL');
/** Separate pool for the background sync worker (see DbModule). */
export const WORKER_DB = Symbol('WORKER_DB');
export const WORKER_PG_POOL = Symbol('WORKER_PG_POOL');

export function createPool(connectionString: string, max: number, applicationName: string): Pool {
  return new Pool({ connectionString, max, application_name: applicationName });
}

export function createDatabase(pool: Pool): Database {
  return drizzle(pool, { schema });
}

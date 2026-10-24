import { Global, Inject, Module, OnApplicationShutdown } from '@nestjs/common';
import { Pool } from 'pg';
import { APP_CONFIG, AppConfig } from '../config';
import { DB, PG_POOL, WORKER_DB, WORKER_PG_POOL, createDatabase, createPool } from './database';

/**
 * Two pools on purpose: HTTP handlers (pay, cancel, ...) and the sync worker never compete for
 * the same connections, so a busy worker cannot push pay latency past its 300 ms budget.
 */
@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) =>
        createPool(config.databaseUrl, config.dbPoolSize, 'ezeats-api'),
    },
    {
      provide: WORKER_PG_POOL,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) =>
        createPool(config.databaseUrl, config.workerDbPoolSize, 'ezeats-sync-worker'),
    },
    { provide: DB, inject: [PG_POOL], useFactory: createDatabase },
    { provide: WORKER_DB, inject: [WORKER_PG_POOL], useFactory: createDatabase },
  ],
  exports: [DB, WORKER_DB],
})
export class DbModule implements OnApplicationShutdown {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(WORKER_PG_POOL) private readonly workerPool: Pool,
  ) {}

  /** Runs after the worker's beforeApplicationShutdown drain, so in-flight steps can finish. */
  async onApplicationShutdown(): Promise<void> {
    await Promise.all([this.pool.end(), this.workerPool.end()]);
  }
}

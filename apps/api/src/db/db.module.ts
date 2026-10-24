import { Global, Inject, Module, OnApplicationShutdown } from '@nestjs/common';
import { Pool } from 'pg';
import { APP_CONFIG, AppConfig } from '../config';
import { DB, PG_POOL, createDatabase, createPool } from './database';

@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => createPool(config.databaseUrl),
    },
    { provide: DB, inject: [PG_POOL], useFactory: createDatabase },
  ],
  exports: [DB, PG_POOL],
})
export class DbModule implements OnApplicationShutdown {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}

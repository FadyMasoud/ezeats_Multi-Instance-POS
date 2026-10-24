import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { APP_CONFIG, AppConfig } from '../config';
import { DB, Database } from '../db/database';

@Controller('health')
export class HealthController {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(DB) private readonly db: Database,
  ) {}

  @Get()
  async health(): Promise<{ status: 'ok'; instanceId: string }> {
    try {
      await this.db.execute(sql`SELECT 1`);
    } catch {
      throw new ServiceUnavailableException('database unavailable');
    }
    return { status: 'ok', instanceId: this.config.instanceId };
  }
}

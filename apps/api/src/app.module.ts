import { DynamicModule, Module } from '@nestjs/common';
import { AdminController } from './admin/admin.controller';
import { AdminGuard } from './admin/admin.guard';
import { ChecksController } from './checks/checks.controller';
import { ChecksService } from './checks/checks.service';
import { APP_CONFIG, AppConfig } from './config';
import { DbModule } from './db/db.module';
import { HealthController } from './health/health.controller';
import { PosClient } from './sync/pos-client';
import { PosRateLimiter } from './sync/rate-limiter';
import { SyncProcessor } from './sync/sync-processor';
import { SyncWorker } from './sync/sync-worker.service';
import { SyncService } from './sync/sync.service';

@Module({})
export class AppModule {
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      global: true,
      imports: [DbModule],
      controllers: [ChecksController, AdminController, HealthController],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        AdminGuard,
        ChecksService,
        SyncService,
        PosClient,
        PosRateLimiter,
        SyncProcessor,
        SyncWorker,
      ],
      exports: [APP_CONFIG],
    };
  }
}

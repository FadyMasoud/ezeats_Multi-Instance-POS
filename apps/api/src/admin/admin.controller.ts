import { Controller, Get, Param, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Length, Max, Min } from 'class-validator';
import { ChecksService } from '../checks/checks.service';
import { type PosErrorKind, posErrorKindEnum } from '../db/schema';
import type { SyncStatusFilter } from '../sync/sync-status.dto';
import { SyncService } from '../sync/sync.service';
import { AdminGuard } from './admin.guard';

const STATUS_FILTERS: SyncStatusFilter[] = [
  'in_progress',
  'awaiting_payment',
  'not_required',
  'processing',
  'pending',
  'retrying',
  'reconciling',
  'cancellation_pending',
  'synced',
  'cancelled',
  'failed',
];

export class SyncListQueryDto {
  @IsOptional()
  @IsIn(STATUS_FILTERS)
  status?: SyncStatusFilter;

  @IsOptional()
  @IsString()
  @Length(1, 64)
  restaurantId?: string;

  @IsOptional()
  @IsIn(posErrorKindEnum.enumValues)
  errorKind?: PosErrorKind;

  @IsOptional()
  @IsString()
  @Length(1, 36)
  q?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize = 25;
}

@Controller('admin')
@UseGuards(AdminGuard)
export class AdminController {
  constructor(
    private readonly sync: SyncService,
    private readonly checks: ChecksService,
  ) {}

  /** Lets the UI validate an operator token before showing anything. */
  @Get('session')
  session(): { ok: true } {
    return { ok: true };
  }

  @Get('sync')
  list(@Query() query: SyncListQueryDto) {
    return this.sync.list(query);
  }

  @Get('sync/summary')
  summary() {
    return this.sync.summary();
  }

  @Get('checks/:id')
  async details(@Param('id', ParseUUIDPipe) id: string) {
    const [check, sync, attempts] = await Promise.all([
      this.checks.get(id),
      this.sync.getStatus(id),
      this.sync.attempts(id),
    ]);
    return { check, sync, attempts };
  }
}

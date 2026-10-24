import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AdminGuard } from '../admin/admin.guard';
import { SyncStatusDto } from '../sync/sync-status.dto';
import { SyncService } from '../sync/sync.service';
import { ChecksService } from './checks.service';
import { CheckResponse } from './dto/check-response.dto';
import { CreateCheckDto } from './dto/create-check.dto';

@Controller('checks')
export class ChecksController {
  constructor(
    private readonly checks: ChecksService,
    private readonly sync: SyncService,
  ) {}

  @Post()
  create(@Body() dto: CreateCheckDto): Promise<CheckResponse> {
    return this.checks.create(dto);
  }

  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string): Promise<CheckResponse> {
    return this.checks.get(id);
  }

  @Post(':id/pay')
  @HttpCode(200)
  pay(@Param('id', ParseUUIDPipe) id: string): Promise<CheckResponse> {
    return this.checks.pay(id);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  cancel(@Param('id', ParseUUIDPipe) id: string): Promise<CheckResponse> {
    return this.checks.cancel(id);
  }

  @Get(':id/sync')
  syncStatus(@Param('id', ParseUUIDPipe) id: string): Promise<SyncStatusDto> {
    return this.sync.getStatus(id);
  }

  /** Operator action: 202 because it only re-queues durable work; the POS call happens later. */
  @Post(':id/sync/retry')
  @HttpCode(202)
  @UseGuards(AdminGuard)
  retrySync(@Param('id', ParseUUIDPipe) id: string): Promise<SyncStatusDto> {
    return this.sync.retry(id);
  }
}

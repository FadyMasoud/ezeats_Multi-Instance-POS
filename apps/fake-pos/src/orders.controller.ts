import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Inject,
  Param,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { FailureConfig, POS_CONFIG, PosConfig } from './pos-config';
import { PosOrder, PosStore } from './pos-store';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface CreateOrderBody {
  externalRef?: unknown;
  restaurantId?: unknown;
  items?: unknown;
  total?: unknown;
}

@Controller()
export class OrdersController {
  constructor(
    private readonly store: PosStore,
    @Inject(POS_CONFIG) private readonly config: PosConfig,
  ) {}

  private get failures(): FailureConfig {
    return this.config.failures;
  }

  @Post('orders')
  async create(@Body() body: CreateOrderBody, @Res() res: Response): Promise<void> {
    const { externalRef, restaurantId, items, total } = body;
    if (
      typeof externalRef !== 'string' ||
      typeof restaurantId !== 'string' ||
      !Array.isArray(items) ||
      typeof total !== 'number'
    ) {
      res
        .status(400)
        .json({ message: 'externalRef, restaurantId, items[] and total are required' });
      return;
    }
    if (this.rejectIfRateLimited(restaurantId, res)) return;
    if (total <= 0) {
      res.status(422).json({ message: `total must be greater than 0 (got ${total})` });
      return;
    }
    if (this.roll(this.failures.failRate)) {
      res.status(500).json({ message: 'POS internal error (simulated)' });
      return;
    }

    const order = this.store.create({ externalRef, restaurantId, items, total });

    if (this.roll(this.failures.timeoutAfterCreateRate)) {
      // The order exists now; the caller just will not hear about it in time.
      await sleep(this.failures.timeoutAfterCreateDelayMs);
    } else {
      await this.maybeSlow();
    }
    res.status(201).json({ posOrderId: order.posOrderId });
  }

  @Get('orders')
  async find(@Query('externalRef') externalRef: string | undefined): Promise<PosOrder[]> {
    if (!externalRef) throw new HttpException('externalRef is required', HttpStatus.BAD_REQUEST);
    if (this.roll(this.failures.failRate)) {
      throw new HttpException('POS internal error (simulated)', HttpStatus.INTERNAL_SERVER_ERROR);
    }
    await this.maybeSlow();
    return this.store.findByExternalRef(externalRef);
  }

  @Post('orders/:posOrderId/cancel')
  async cancel(@Param('posOrderId') posOrderId: string, @Res() res: Response): Promise<void> {
    const order = this.store.get(posOrderId);
    if (!order) {
      res.status(404).json({ message: `order ${posOrderId} not found` });
      return;
    }
    if (this.rejectIfRateLimited(order.restaurantId, res)) return;
    if (this.roll(this.failures.failRate)) {
      res.status(500).json({ message: 'POS internal error (simulated)' });
      return;
    }
    this.store.cancel(order);
    await this.maybeSlow();
    res.status(200).json({ posOrderId: order.posOrderId, status: order.status });
  }

  @Get('debug/orders')
  debugOrders(): PosOrder[] {
    return this.store.all();
  }

  /** Test helper: clear all orders and rate-limit history. */
  @Post('debug/reset')
  @HttpCode(200)
  reset(): { ok: true } {
    this.store.reset();
    return { ok: true };
  }

  @Get('debug/config')
  getConfig(): FailureConfig {
    return this.failures;
  }

  /** Test helper: change failure rates at runtime (env vars set the starting values). */
  @Post('debug/config')
  @HttpCode(200)
  setConfig(@Body() patch: Partial<FailureConfig>): FailureConfig {
    for (const [key, value] of Object.entries(patch)) {
      if (
        !(key in this.failures) ||
        typeof value !== 'number' ||
        !Number.isFinite(value) ||
        value < 0
      ) {
        throw new HttpException(`invalid config field ${key}`, HttpStatus.BAD_REQUEST);
      }
      if (key.endsWith('Rate') && value > 1) {
        throw new HttpException(`${key} must be between 0 and 1`, HttpStatus.BAD_REQUEST);
      }
    }
    Object.assign(this.failures, patch);
    return this.failures;
  }

  @Get('health')
  health(): { status: 'ok' } {
    return { status: 'ok' };
  }

  private rejectIfRateLimited(restaurantId: string, res: Response): boolean {
    const retryAfter = this.store.admit(restaurantId);
    if (retryAfter === null) return false;
    res
      .status(429)
      .setHeader('Retry-After', String(retryAfter))
      .json({ message: `rate limit exceeded for restaurant ${restaurantId}` });
    return true;
  }

  private roll(probability: number): boolean {
    return probability > 0 && Math.random() < probability;
  }

  private async maybeSlow(): Promise<void> {
    if (!this.roll(this.failures.slowRate)) return;
    const { slowMinMs, slowMaxMs } = this.failures;
    await sleep(slowMinMs + Math.random() * Math.max(0, slowMaxMs - slowMinMs));
  }
}

import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { POS_CONFIG, PosConfig } from './pos-config';

export interface PosOrder {
  posOrderId: string;
  externalRef: string;
  restaurantId: string;
  items: unknown[];
  total: number;
  status: 'open' | 'cancelled';
  createdAt: string;
  cancelledAt: string | null;
}

/** In-memory POS state. Deliberately NOT idempotent: every create makes a new order. */
@Injectable()
export class PosStore {
  private readonly orders = new Map<string, PosOrder>();
  private readonly requestLog = new Map<string, number[]>();
  private sequence = 0;

  constructor(@Inject(POS_CONFIG) private readonly config: PosConfig) {}

  create(input: Pick<PosOrder, 'externalRef' | 'restaurantId' | 'items' | 'total'>): PosOrder {
    this.sequence += 1;
    const order: PosOrder = {
      ...input,
      // Sequence prefix keeps ids sortable in creation order, which helps when reading logs.
      posOrderId: `pos_${String(this.sequence).padStart(6, '0')}_${randomUUID().slice(0, 8)}`,
      status: 'open',
      createdAt: new Date().toISOString(),
      cancelledAt: null,
    };
    this.orders.set(order.posOrderId, order);
    return order;
  }

  findByExternalRef(externalRef: string): PosOrder[] {
    return [...this.orders.values()].filter((o) => o.externalRef === externalRef);
  }

  get(posOrderId: string): PosOrder | undefined {
    return this.orders.get(posOrderId);
  }

  /** Idempotent: cancelling a cancelled order succeeds and changes nothing. */
  cancel(order: PosOrder): PosOrder {
    if (order.status === 'open') {
      order.status = 'cancelled';
      order.cancelledAt = new Date().toISOString();
    }
    return order;
  }

  all(): PosOrder[] {
    return [...this.orders.values()];
  }

  /**
   * Sliding window per restaurant. Every request that passes this check counts, including ones
   * that later fail with 500/422, as a real POS would count them.
   * Returns null when admitted, or the seconds until a slot frees up.
   */
  admit(restaurantId: string, now = Date.now()): number | null {
    const windowStart = now - this.config.rateWindowMs;
    const log = (this.requestLog.get(restaurantId) ?? []).filter((t) => t > windowStart);
    if (log.length >= this.config.rateLimit) {
      this.requestLog.set(restaurantId, log);
      const oldest = log[0] ?? now;
      return Math.max(1, Math.ceil((oldest + this.config.rateWindowMs - now) / 1000));
    }
    log.push(now);
    this.requestLog.set(restaurantId, log);
    return null;
  }

  reset(): void {
    this.orders.clear();
    this.requestLog.clear();
    this.sequence = 0;
  }
}

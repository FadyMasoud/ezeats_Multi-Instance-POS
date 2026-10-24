import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../config';
import type { PosError, PosOrderSummary, PosOutcome } from './sync-machine';

export interface PosOrderItem {
  name: string;
  quantity: number;
  unitPrice: number;
}

export interface CreatePosOrderInput {
  externalRef: string;
  restaurantId: string;
  items: PosOrderItem[];
  total: number;
}

type HttpResult = { status: number; body: unknown; headers: Headers } | { error: PosError };

/** Connection errors where the request provably never reached the POS. */
const NOT_SENT_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']);

@Injectable()
export class PosClient {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  async createOrder(input: CreatePosOrderInput): Promise<PosOutcome> {
    const res = await this.request('POST', '/orders', input);
    if ('error' in res) return { action: 'create', ok: false, error: res.error };
    if (res.status === 201 || res.status === 200) {
      const posOrderId = (res.body as { posOrderId?: unknown } | null)?.posOrderId;
      if (typeof posOrderId === 'string' && posOrderId.length > 0) {
        return { action: 'create', ok: true, posOrderId };
      }
      // 2xx without an id: the order may exist; reconcile rather than guess.
      return {
        action: 'create',
        ok: false,
        error: unexpected(res.status, 'create returned no posOrderId'),
      };
    }
    return {
      action: 'create',
      ok: false,
      error: this.classifyStatus(res.status, res.body, res.headers),
    };
  }

  async findOrders(externalRef: string): Promise<PosOutcome> {
    const res = await this.request('GET', `/orders?externalRef=${encodeURIComponent(externalRef)}`);
    if ('error' in res) return { action: 'lookup', ok: false, error: res.error };
    if (res.status !== 200) {
      return {
        action: 'lookup',
        ok: false,
        error: this.classifyStatus(res.status, res.body, res.headers),
      };
    }
    const orders = parseOrders(res.body, externalRef);
    if (!orders) {
      return {
        action: 'lookup',
        ok: false,
        error: unexpected(res.status, 'malformed lookup response'),
      };
    }
    return { action: 'lookup', ok: true, orders };
  }

  async cancelOrder(posOrderId: string): Promise<PosOutcome> {
    const res = await this.request('POST', `/orders/${encodeURIComponent(posOrderId)}/cancel`);
    if ('error' in res) return { action: 'cancel', ok: false, error: res.error };
    if (res.status === 200 || res.status === 204) return { action: 'cancel', ok: true };
    return {
      action: 'cancel',
      ok: false,
      error: this.classifyStatus(res.status, res.body, res.headers),
    };
  }

  private async request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<HttpResult> {
    try {
      const response = await fetch(`${this.config.posBaseUrl}${path}`, {
        method,
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.config.worker.posTimeoutMs),
      });
      const text = await response.text();
      return { status: response.status, body: safeJson(text), headers: response.headers };
    } catch (error) {
      return { error: this.classifyThrown(error) };
    }
  }

  private classifyThrown(error: unknown): PosError {
    const name = (error as { name?: string })?.name;
    if (name === 'TimeoutError' || name === 'AbortError') {
      return {
        kind: 'timeout',
        status: null,
        message: `POS did not respond within ${this.config.worker.posTimeoutMs} ms`,
        definitelyNotApplied: false,
        retryAfterMs: null,
      };
    }
    const cause = (error as { cause?: { code?: string; message?: string } })?.cause;
    const code = cause?.code ?? '';
    return {
      kind: 'network',
      status: null,
      message: `POS request failed: ${code || cause?.message || String(error)}`,
      definitelyNotApplied: NOT_SENT_CODES.has(code),
      retryAfterMs: null,
    };
  }

  private classifyStatus(status: number, body: unknown, headers: Headers): PosError {
    const detail = errorMessage(body) ?? `HTTP ${status}`;
    if (status === 429) {
      const retryAfterSeconds = Number(headers.get('retry-after'));
      return {
        kind: 'rate_limited',
        status,
        message: `POS rate limit hit: ${detail}`,
        definitelyNotApplied: true,
        retryAfterMs:
          Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
            ? retryAfterSeconds * 1000
            : this.config.rateLimit.windowMs,
      };
    }
    if (status === 500) {
      // POS contract: 500 means nothing was created. Other 5xx (proxies, gateways) are treated
      // as ambiguous below because we cannot know whether the POS processed the request.
      return {
        kind: 'server_error',
        status,
        message: detail,
        definitelyNotApplied: true,
        retryAfterMs: null,
      };
    }
    if (status > 500) {
      return {
        kind: 'server_error',
        status,
        message: detail,
        definitelyNotApplied: false,
        retryAfterMs: null,
      };
    }
    if (status >= 400) {
      return {
        kind: 'rejected',
        status,
        message: detail,
        definitelyNotApplied: true,
        retryAfterMs: null,
      };
    }
    return unexpected(status, `unexpected status ${status}`);
  }
}

function unexpected(status: number, message: string): PosError {
  return { kind: 'unexpected', status, message, definitelyNotApplied: false, retryAfterMs: null };
}

function safeJson(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function errorMessage(body: unknown): string | null {
  if (typeof body === 'string' && body.length > 0) return body.slice(0, 500);
  if (body && typeof body === 'object') {
    const { message, error } = body as { message?: unknown; error?: unknown };
    const text = Array.isArray(message) ? message.join('; ') : (message ?? error);
    if (typeof text === 'string' && text.length > 0) return text.slice(0, 500);
  }
  return null;
}

function parseOrders(body: unknown, externalRef: string): PosOrderSummary[] | null {
  if (!Array.isArray(body)) return null;
  const orders: PosOrderSummary[] = [];
  for (const raw of body) {
    const o = raw as Record<string, unknown>;
    if (typeof o.posOrderId !== 'string') return null;
    // Defensive: never adopt an order that is not ours, whatever the POS filter does.
    if (o.externalRef !== undefined && o.externalRef !== externalRef) continue;
    orders.push({
      posOrderId: o.posOrderId,
      status: o.status === 'cancelled' ? 'cancelled' : 'open',
      createdAt: typeof o.createdAt === 'string' ? o.createdAt : '',
    });
  }
  return orders;
}

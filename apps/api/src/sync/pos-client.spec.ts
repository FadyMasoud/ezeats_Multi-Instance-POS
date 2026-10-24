import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../config';
import { PosClient } from './pos-client';

const client = new PosClient(loadConfig({ DATABASE_URL: 'postgres://unused/db' }));
const create = () =>
  client.createOrder({ externalRef: 'c1', restaurantId: 'r1', items: [], total: 10 });

function respond(status: number, body: unknown = {}, headers: Record<string, string> = {}) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body), { status, headers })),
  );
}

function fail(error: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw error;
    }),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('PosClient create classification', () => {
  it('returns the order id on 201', async () => {
    respond(201, { posOrderId: 'p1' });
    expect(await create()).toEqual({ action: 'create', ok: true, posOrderId: 'p1' });
  });

  // definitelyNotApplied=true clears create_sent_at, which allows a second create. Only outcomes
  // the POS contract (or TCP) guarantees created nothing may be on this list.
  it.each([
    [422, 'rejected', true],
    [429, 'rate_limited', true],
    [500, 'server_error', true],
    [400, 'rejected', false],
    [401, 'rejected', false],
    [404, 'rejected', false],
    [408, 'rejected', false],
    [409, 'rejected', false],
    [502, 'server_error', false],
    [503, 'server_error', false],
    [504, 'server_error', false],
    [307, 'unexpected', false],
    [308, 'unexpected', false],
  ])('HTTP %i -> %s, definitelyNotApplied=%s', async (status, kind, notApplied) => {
    respond(status, { message: 'x' });
    const outcome = await create();
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toMatchObject({ kind, status, definitelyNotApplied: notApplied });
  });

  it('treats a 2xx without an id as ambiguous', async () => {
    respond(201, {});
    const outcome = await create();
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.definitelyNotApplied).toBe(false);
  });

  it('uses Retry-After for 429', async () => {
    respond(429, {}, { 'retry-after': '3' });
    const outcome = await create();
    if (!outcome.ok) expect(outcome.error.retryAfterMs).toBe(3000);
  });

  it('timeouts and resets are ambiguous; a refused connection is not', async () => {
    fail(Object.assign(new Error('t'), { name: 'TimeoutError' }));
    let outcome = await create();
    if (!outcome.ok)
      expect(outcome.error).toMatchObject({ kind: 'timeout', definitelyNotApplied: false });

    fail(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }));
    outcome = await create();
    if (!outcome.ok)
      expect(outcome.error).toMatchObject({ kind: 'network', definitelyNotApplied: false });

    fail(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }));
    outcome = await create();
    if (!outcome.ok)
      expect(outcome.error).toMatchObject({ kind: 'network', definitelyNotApplied: true });
  });

  it('does not follow redirects', async () => {
    respond(201, { posOrderId: 'p1' });
    await create();
    const [, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0] ?? [];
    expect(init).toMatchObject({ redirect: 'manual' });
  });
});

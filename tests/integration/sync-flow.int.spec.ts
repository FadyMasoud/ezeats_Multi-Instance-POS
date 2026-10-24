import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { posSync, posSyncAttempts } from '../../apps/api/src/db/schema';
import {
  type ApiInstance,
  type FakePos,
  createPaidCheck,
  openOrdersFor,
  settle,
  sleep,
  startApi,
  startFakePos,
  syncOf,
  truncateAll,
  uniqueRestaurant,
} from './harness';

describe('POS sync flows (real Postgres + fake POS)', () => {
  let pos: FakePos;
  let api: ApiInstance;

  beforeAll(async () => {
    pos = await startFakePos();
    api = await startApi(pos.url);
  });
  afterAll(async () => {
    await api.close();
    await pos.close();
  });
  beforeEach(async () => {
    await truncateAll(api.db);
    pos.store.reset();
    pos.setFailures({ failRate: 0, slowRate: 0, timeoutAfterCreateRate: 0 });
  });

  const attemptsOf = (checkId: string) =>
    api.db
      .select()
      .from(posSyncAttempts)
      .where(eq(posSyncAttempts.checkId, checkId))
      .orderBy(posSyncAttempts.id);

  it('syncs a paid check to exactly one POS order with the check as externalRef', async () => {
    const restaurant = uniqueRestaurant();
    const id = await createPaidCheck(api, restaurant, 99.5);
    const [status] = await settle([api], [id]);
    expect(status).toMatchObject({ state: 'synced', attempts: 1, lastError: null });
    const orders = pos.store.findByExternalRef(id);
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({
      restaurantId: restaurant,
      total: 99.5,
      status: 'open',
      posOrderId: status?.posOrderId,
    });
  });

  it('retries 500s with backoff and still creates only one order', async () => {
    pos.setFailures({ failRate: 1 });
    const id = await createPaidCheck(api, uniqueRestaurant());
    for (let i = 0; i < 3; i++) {
      await api.worker.tick();
      await api.worker.drain();
      await sleep(120);
    }
    const during = await syncOf(api, id);
    expect(during).toMatchObject({ state: 'pending', displayStatus: 'retrying' });
    expect(during.consecutiveFailures).toBeGreaterThanOrEqual(2);
    expect(during.lastError).toMatchObject({ kind: 'server_error', httpStatus: 500 });
    expect(during.nextAttemptAt).not.toBeNull();

    pos.setFailures({ failRate: 0 });
    const [status] = await settle([api], [id]);
    expect(status).toMatchObject({ state: 'synced', consecutiveFailures: 0 });
    expect(pos.store.findByExternalRef(id)).toHaveLength(1);
  });

  it('stops on 422, shows the reason, and never retries on its own', async () => {
    const id = await createPaidCheck(api, uniqueRestaurant(), 0);
    const [status] = await settle([api], [id]);
    expect(status).toMatchObject({
      state: 'failed',
      displayStatus: 'failed',
      retryable: true,
      nextAttemptAt: null,
      lastError: { kind: 'rejected', httpStatus: 422 },
    });
    expect(status?.lastError?.message).toMatch(/total must be greater than 0/);
    for (let i = 0; i < 3; i++) await api.worker.tick();
    await api.worker.drain();
    expect((await syncOf(api, id)).attempts).toBe(1);
    expect(pos.store.all()).toHaveLength(0);
  });

  it('parks a sync as failed when the retry budget is exhausted', async () => {
    pos.setFailures({ failRate: 1 });
    const id = await createPaidCheck(api, uniqueRestaurant());
    const [status] = await settle([api], [id]);
    expect(status).toMatchObject({
      state: 'failed',
      retryable: true,
      lastError: { kind: 'retries_exhausted' },
    });
    expect(status?.attempts).toBe(api.config.worker.maxConsecutiveFailures);
    expect(status?.lastError?.message).toMatch(/server_error/);
  });

  it('reconciles a create that timed out after the POS created it: no duplicate', async () => {
    pos.setFailures({ timeoutAfterCreateRate: 1 });
    const id = await createPaidCheck(api, uniqueRestaurant());
    await api.worker.tick();
    await api.worker.drain();
    const afterTimeout = await syncOf(api, id);
    expect(afterTimeout).toMatchObject({ state: 'reconciling', lastError: { kind: 'timeout' } });
    expect(afterTimeout.createSentAt).not.toBeNull();

    pos.setFailures({ timeoutAfterCreateRate: 0 });
    const [status] = await settle([api], [id]);
    expect(status?.state).toBe('synced');
    expect(pos.store.findByExternalRef(id)).toHaveLength(1);
    const ops = (await attemptsOf(id)).map((a) => `${a.operation}:${a.ok}`);
    expect(ops).toEqual(['create:false', 'lookup:true']);
  });

  it('cancel before the create was sent: the POS is never contacted', async () => {
    const id = await createPaidCheck(api, uniqueRestaurant());
    await api.http.post(`/checks/${id}/cancel`).expect(200);
    expect(await syncOf(api, id)).toMatchObject({ state: 'cancelled', attempts: 0 });
    await settle([api], [id]);
    expect(pos.store.all()).toHaveLength(0);
  });

  it('cancel while a create is in flight: create lands first, then it is cancelled', async () => {
    pos.setFailures({ slowRate: 1, slowMinMs: 400, slowMaxMs: 450 });
    const id = await createPaidCheck(api, uniqueRestaurant());
    await api.worker.tick();
    await sleep(100);
    await api.http.post(`/checks/${id}/cancel`).expect(200);
    expect((await syncOf(api, id)).cancelRequested).toBe(true);
    pos.setFailures({ slowRate: 0 });

    const [status] = await settle([api], [id]);
    expect(status).toMatchObject({ state: 'cancelled', posOrderStatus: 'cancelled' });
    expect(openOrdersFor(pos, id)).toHaveLength(0);
    expect(pos.store.findByExternalRef(id)).toHaveLength(1);
    const ops = (await attemptsOf(id)).map((a) => a.operation);
    expect(ops).toEqual(['create', 'cancel']);
  });

  it('cancel after an ambiguous create: looks the order up, then cancels it', async () => {
    pos.setFailures({ timeoutAfterCreateRate: 1 });
    const id = await createPaidCheck(api, uniqueRestaurant());
    await api.worker.tick();
    await api.worker.drain();
    await api.http.post(`/checks/${id}/cancel`).expect(200);
    pos.setFailures({ timeoutAfterCreateRate: 0 });

    const [status] = await settle([api], [id]);
    expect(status?.state).toBe('cancelled');
    expect(openOrdersFor(pos, id)).toHaveLength(0);
    expect((await attemptsOf(id)).map((a) => a.operation)).toEqual(['create', 'lookup', 'cancel']);
  });

  it('cancel after a create that never landed: closes without creating anything', async () => {
    const id = await createPaidCheck(api, uniqueRestaurant());
    // Simulate a crash right after create_sent_at was committed, before the request left.
    await api.db
      .update(posSync)
      .set({ createSentAt: sql`now() - interval '5 seconds'`, state: 'reconciling' })
      .where(eq(posSync.checkId, id));
    await api.http.post(`/checks/${id}/cancel`).expect(200);
    const [status] = await settle([api], [id]);
    expect(status?.state).toBe('cancelled');
    expect(pos.store.all()).toHaveLength(0);
    expect((await attemptsOf(id)).map((a) => a.operation)).toEqual(['lookup']);
  });

  it('heals duplicates found during reconciliation: keeps one open order', async () => {
    const restaurant = uniqueRestaurant();
    const id = await createPaidCheck(api, restaurant);
    // Two orders already exist for this externalRef (e.g. a create that landed very late).
    pos.store.create({ externalRef: id, restaurantId: restaurant, items: [], total: 1 });
    pos.store.create({ externalRef: id, restaurantId: restaurant, items: [], total: 1 });
    await api.db
      .update(posSync)
      .set({ createSentAt: sql`now() - interval '5 seconds'`, state: 'reconciling' })
      .where(eq(posSync.checkId, id));

    const [status] = await settle([api], [id]);
    expect(status?.state).toBe('synced');
    const open = openOrdersFor(pos, id);
    expect(open).toHaveLength(1);
    expect(open[0]?.posOrderId).toBe(status?.posOrderId);
    expect(pos.store.findByExternalRef(id)).toHaveLength(2);
  });
});

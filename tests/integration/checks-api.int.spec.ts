import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  type ApiInstance,
  type FakePos,
  createCheck,
  createPaidCheck,
  settle,
  startApi,
  startFakePos,
  syncOf,
  truncateAll,
  uniqueRestaurant,
} from './harness';

describe('checks API (real Postgres)', () => {
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

  it('creates an open check with its items', async () => {
    const res = await api.http
      .post('/checks')
      .send({
        restaurantId: 'r-1',
        items: [{ name: 'Feteer', quantity: 2, unitPrice: 40 }],
        total: 80,
      })
      .expect(201);
    expect(res.body).toMatchObject({
      restaurantId: 'r-1',
      status: 'open',
      total: 80,
      items: [{ name: 'Feteer', quantity: 2, unitPrice: 40 }],
      paidAt: null,
    });
    const sync = await syncOf(api, res.body.id);
    expect(sync).toMatchObject({
      state: null,
      displayStatus: 'awaiting_payment',
      retryable: false,
    });
  });

  it.each([
    [{ items: [{ name: 'x', quantity: 1, unitPrice: 1 }], total: 1 }],
    [{ restaurantId: 'r', items: [], total: 1 }],
    [{ restaurantId: 'r', items: [{ name: 'x', quantity: 0, unitPrice: 1 }], total: 1 }],
    [{ restaurantId: 'r', items: [{ name: 'x', quantity: 1, unitPrice: 1 }], total: 'ten' }],
    [
      {
        restaurantId: 'r',
        items: [{ name: 'x', quantity: 1, unitPrice: 1 }],
        total: 1,
        extra: true,
      },
    ],
  ])('rejects an invalid payload %#', async (body) => {
    await api.http.post('/checks').send(body).expect(400);
  });

  it('returns 404 for unknown checks and 400 for malformed ids', async () => {
    await api.http.post('/checks/00000000-0000-4000-8000-000000000000/pay').expect(404);
    await api.http.get('/checks/not-a-uuid/sync').expect(400);
  });

  it('pay writes the outbox row atomically and is idempotent', async () => {
    const id = await createCheck(api, uniqueRestaurant());
    const first = await api.http.post(`/checks/${id}/pay`).expect(200);
    const second = await api.http.post(`/checks/${id}/pay`).expect(200);
    expect(first.body.status).toBe('paid');
    expect(second.body.paidAt).toBe(first.body.paidAt);
    const sync = await syncOf(api, id);
    expect(sync).toMatchObject({ state: 'pending', externalRef: id, attempts: 0 });
    // Paying twice did not enqueue twice: the worker creates exactly one POS order.
    await settle([api], [id]);
    expect(pos.store.findByExternalRef(id)).toHaveLength(1);
  });

  it('pay responds well under 300 ms while the POS is unreachable', async () => {
    const down = await startApi('http://127.0.0.1:9', { instanceId: 'pos-down' });
    try {
      const restaurant = uniqueRestaurant();
      const ids = await Promise.all(
        Array.from({ length: 10 }, () => createCheck(down, restaurant)),
      );
      // Keep the worker busy failing against the dead POS while we pay.
      const background = down.worker.tick();
      const timings: number[] = [];
      for (const id of ids) {
        const started = performance.now();
        await down.http.post(`/checks/${id}/pay`).expect(200);
        timings.push(performance.now() - started);
      }
      await background;
      await down.worker.drain();
      expect(Math.max(...timings)).toBeLessThan(300);
    } finally {
      await down.close();
    }
  });

  it('pay responds well under 300 ms while the POS is slow', async () => {
    pos.setFailures({ slowRate: 1, slowMinMs: 600, slowMaxMs: 650 });
    const ids = await Promise.all(
      Array.from({ length: 5 }, () => createCheck(api, uniqueRestaurant())),
    );
    await api.http.post(`/checks/${ids[0]}/pay`).expect(200);
    await api.worker.tick(); // a slow create is now in flight
    for (const id of ids.slice(1)) {
      const started = performance.now();
      await api.http.post(`/checks/${id}/pay`).expect(200);
      expect(performance.now() - started).toBeLessThan(300);
    }
    await api.worker.drain();
  });

  it('cancelling an open check needs no POS work', async () => {
    const id = await createCheck(api, uniqueRestaurant());
    const res = await api.http.post(`/checks/${id}/cancel`).expect(200);
    expect(res.body.status).toBe('cancelled');
    expect(await syncOf(api, id)).toMatchObject({ state: null, displayStatus: 'not_required' });
    await api.http.post(`/checks/${id}/pay`).expect(409);
    await api.http.post(`/checks/${id}/cancel`).expect(200); // idempotent
    expect(pos.store.all()).toHaveLength(0);
  });

  it('cancelling a synced check cancels its POS order', async () => {
    const id = await createPaidCheck(api, uniqueRestaurant());
    await settle([api], [id]);
    await api.http.post(`/checks/${id}/cancel`).expect(200);
    const [status] = await settle([api], [id]);
    expect(status).toMatchObject({ state: 'cancelled', posOrderStatus: 'cancelled' });
    const orders = pos.store.findByExternalRef(id);
    expect(orders).toHaveLength(1);
    expect(orders[0]?.status).toBe('cancelled');
  });
});

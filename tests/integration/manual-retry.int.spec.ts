import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ADMIN_TOKEN,
  type ApiInstance,
  type FakePos,
  createPaidCheck,
  settle,
  startApi,
  startFakePos,
  syncOf,
  truncateAll,
  uniqueRestaurant,
} from './harness';

describe('POST /checks/:id/sync/retry', () => {
  let pos: FakePos;
  let api: ApiInstance;

  const retry = (id: string, token: string | null = ADMIN_TOKEN) => {
    const req = api.http.post(`/checks/${id}/sync/retry`);
    return token === null ? req : req.set('x-admin-token', token);
  };

  beforeAll(async () => {
    pos = await startFakePos();
    api = await startApi(pos.url, { worker: { maxConsecutiveFailures: 3 } });
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

  it('requires an operator token', async () => {
    const id = await createPaidCheck(api, uniqueRestaurant(), 0);
    await settle([api], [id]);
    await retry(id, null).expect(401);
    await retry(id, 'wrong-token').expect(401);
    expect((await syncOf(api, id)).state).toBe('failed');
  });

  it('resumes a sync stopped by exhausted retries and creates exactly one order', async () => {
    pos.setFailures({ failRate: 1 });
    const id = await createPaidCheck(api, uniqueRestaurant());
    const [stopped] = await settle([api], [id]);
    expect(stopped).toMatchObject({ state: 'failed', retryable: true });

    pos.setFailures({ failRate: 0 });
    const res = await retry(id).expect(202);
    // The endpoint only re-queues; it never calls the POS itself.
    expect(res.body).toMatchObject({ state: 'pending', manualRetries: 1, consecutiveFailures: 0 });
    expect(pos.store.all()).toHaveLength(0);

    const [status] = await settle([api], [id]);
    expect(status?.state).toBe('synced');
    expect(pos.store.findByExternalRef(id)).toHaveLength(1);
  });

  it('a 422 stays rejected after a manual retry and remains visible', async () => {
    const id = await createPaidCheck(api, uniqueRestaurant(), 0);
    await settle([api], [id]);
    await retry(id).expect(202);
    const [status] = await settle([api], [id]);
    expect(status).toMatchObject({
      state: 'failed',
      manualRetries: 1,
      attempts: 2,
      lastError: { kind: 'rejected', httpStatus: 422 },
    });
  });

  it('reconciles first when the stopped sync may already have created an order', async () => {
    pos.setFailures({ timeoutAfterCreateRate: 1 });
    const id = await createPaidCheck(api, uniqueRestaurant());
    // Every create times out; lookups then fail too, so the sync stops in "maybe created".
    await api.worker.tick();
    await api.worker.drain();
    pos.setFailures({ timeoutAfterCreateRate: 0, failRate: 1 });
    const [stopped] = await settle([api], [id]);
    expect(stopped?.state).toBe('failed');
    expect(stopped?.createSentAt).not.toBeNull();

    pos.setFailures({ failRate: 0 });
    const res = await retry(id).expect(202);
    expect(res.body.state).toBe('reconciling');
    const [status] = await settle([api], [id]);
    expect(status?.state).toBe('synced');
    expect(pos.store.findByExternalRef(id)).toHaveLength(1);
  });

  it('refuses to retry a synced check and creates nothing', async () => {
    const id = await createPaidCheck(api, uniqueRestaurant());
    await settle([api], [id]);
    const res = await retry(id).expect(409);
    expect(res.body).toMatchObject({ code: 'SYNC_SYNCED' });
    expect(res.body.message).toMatch(/already synced/);
    await settle([api], [id]);
    expect(pos.store.findByExternalRef(id)).toHaveLength(1);
  });

  it('refuses to retry an active sync or an unpaid check', async () => {
    const paid = await createPaidCheck(api, uniqueRestaurant());
    await retry(paid).expect(409);
    const res = await api.http
      .post('/checks')
      .send({ restaurantId: 'r', items: [{ name: 'x', quantity: 1, unitPrice: 1 }], total: 1 })
      .expect(201);
    const unpaid = await retry(res.body.id).expect(409);
    expect(unpaid.body.code).toBe('SYNC_NOT_STARTED');
  });

  it('concurrent retries: exactly one is accepted', async () => {
    const id = await createPaidCheck(api, uniqueRestaurant(), 0);
    await settle([api], [id]);
    const results = await Promise.all(Array.from({ length: 5 }, () => retry(id)));
    const codes = results.map((r) => r.status).sort();
    expect(codes).toEqual([202, 409, 409, 409, 409]);
  });
});

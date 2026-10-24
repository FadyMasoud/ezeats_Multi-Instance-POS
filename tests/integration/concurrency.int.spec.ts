import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { posSync, posSyncAttempts } from '../../apps/api/src/db/schema';
import { PosRateLimiter } from '../../apps/api/src/sync/rate-limiter';
import { SyncProcessor } from '../../apps/api/src/sync/sync-processor';
import {
  type ApiInstance,
  type FakePos,
  RATE_WINDOW_MS,
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

describe('multiple API instances, restarts and rate limits (real Postgres)', () => {
  let pos: FakePos;
  let a: ApiInstance;
  let b: ApiInstance;

  beforeAll(async () => {
    pos = await startFakePos();
    a = await startApi(pos.url, { instanceId: 'api-a' });
    b = await startApi(pos.url, { instanceId: 'api-b' });
  });
  afterAll(async () => {
    await a.close();
    await b.close();
    await pos.close();
  });
  beforeEach(async () => {
    await truncateAll(a.db);
    pos.store.reset();
    pos.setFailures({ failRate: 0, slowRate: 0, timeoutAfterCreateRate: 0 });
  });

  it('two instances never claim the same row', async () => {
    const restaurants = Array.from({ length: 20 }, () => uniqueRestaurant());
    await Promise.all(restaurants.map((r, i) => createPaidCheck(i % 2 ? a : b, r)));
    const [claimsA, claimsB] = await Promise.all([
      a.app.get(SyncProcessor).claimDue(20),
      b.app.get(SyncProcessor).claimDue(20),
    ]);
    const ids = [...claimsA, ...claimsB].map((c) => c.checkId);
    expect(ids).toHaveLength(20);
    expect(new Set(ids).size).toBe(20);
  });

  it('two instances working concurrently under POS failures: one open order per check', async () => {
    pos.setFailures({
      failRate: 0.3,
      slowRate: 0.2,
      timeoutAfterCreateRate: 0.15,
      slowMinMs: 100,
      slowMaxMs: 300,
      timeoutAfterCreateDelayMs: 900,
    });
    const restaurants = Array.from({ length: 6 }, () => uniqueRestaurant());
    const ids = await Promise.all(
      Array.from({ length: 36 }, (_, i) =>
        createPaidCheck(i % 2 ? a : b, restaurants[i % restaurants.length] ?? 'r'),
      ),
    );
    const cancelled = ids.filter((_, i) => i % 5 === 0);
    await Promise.all(
      cancelled.map((id, i) => (i % 2 ? a : b).http.post(`/checks/${id}/cancel`).expect(200)),
    );

    const statuses = await settle([a, b], ids, 90_000);
    for (const status of statuses) {
      const open = openOrdersFor(pos, status.checkId);
      if (cancelled.includes(status.checkId)) {
        expect(status.state).toBe('cancelled');
        expect(open).toHaveLength(0);
      } else {
        expect(status.state).toBe('synced');
        expect(open).toHaveLength(1);
      }
    }
    const refs = new Set(ids);
    expect(pos.store.all().every((o) => refs.has(o.externalRef))).toBe(true);
    // Both instances did real work.
    const owners = await a.db
      .selectDistinct({ instance: posSyncAttempts.instanceId })
      .from(posSyncAttempts);
    expect(owners.map((o) => o.instance).sort()).toEqual(['api-a', 'api-b']);
  });

  it('recovers a row abandoned by a crashed instance after the create reached the POS', async () => {
    const restaurant = uniqueRestaurant();
    const id = await createPaidCheck(a, restaurant);
    // The dead instance had committed create_sent_at, sent the request (the POS created the
    // order), and died before recording the response. Its lease is still valid for a moment.
    pos.store.create({ externalRef: id, restaurantId: restaurant, items: [], total: 120.5 });
    await a.db
      .update(posSync)
      .set({
        createSentAt: sql`now()`,
        state: 'pending',
        leaseOwner: 'dead-instance',
        leaseToken: sql`gen_random_uuid()`,
        leaseUntil: sql`now() + interval '700 milliseconds'`,
      })
      .where(eq(posSync.checkId, id));

    expect(await b.worker.tick()).toBe(0); // lease still held: nobody steals it
    expect((await syncOf(b, id)).displayStatus).toBe('processing');
    await sleep(800);
    const [status] = await settle([b], [id]);
    expect(status?.state).toBe('synced');
    expect(pos.store.findByExternalRef(id)).toHaveLength(1);
  });

  it('recovers a row abandoned after create_sent_at was committed but before the request left', async () => {
    const id = await createPaidCheck(a, uniqueRestaurant());
    await a.db
      .update(posSync)
      .set({
        createSentAt: sql`now() - interval '2 seconds'`,
        leaseOwner: 'dead-instance',
        leaseToken: sql`gen_random_uuid()`,
        leaseUntil: sql`now() - interval '1 second'`,
      })
      .where(eq(posSync.checkId, id));
    const [status] = await settle([b], [id]);
    expect(status?.state).toBe('synced');
    expect(pos.store.findByExternalRef(id)).toHaveLength(1);
  });

  it('a stale instance whose lease was taken over cannot overwrite the new owner', async () => {
    pos.setFailures({ slowRate: 1, slowMinMs: 500, slowMaxMs: 550 });
    const id = await createPaidCheck(a, uniqueRestaurant());
    await a.worker.tick(); // A starts a slow create
    await sleep(150);
    // Simulate A's lease expiring mid-request and B taking over.
    await a.db
      .update(posSync)
      .set({ leaseUntil: sql`now() - interval '1 millisecond'` })
      .where(eq(posSync.checkId, id));
    pos.setFailures({ slowRate: 0 });
    await b.worker.tick();
    await Promise.all([a.worker.drain(), b.worker.drain()]);
    const [status] = await settle([a, b], [id]);
    expect(status?.state).toBe('synced');
    expect(openOrdersFor(pos, id)).toHaveLength(1);
  });

  it('the per-restaurant budget is shared across instances', async () => {
    const restaurant = uniqueRestaurant();
    const limiters = [a.app.get(PosRateLimiter), b.app.get(PosRateLimiter)];
    const decisions = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        (i % 2 ? a : b).db.transaction((tx) =>
          (limiters[i % 2] as PosRateLimiter).tryAcquire(tx, restaurant),
        ),
      ),
    );
    expect(decisions.filter((d) => d.allowed)).toHaveLength(5);
    const other = await a.db.transaction((tx) =>
      (limiters[0] as PosRateLimiter).tryAcquire(tx, uniqueRestaurant()),
    );
    expect(other.allowed).toBe(true);
  });

  it('respects the POS limit without hitting 429, and a busy restaurant does not delay others', async () => {
    const busy = uniqueRestaurant('busy');
    const quiet = uniqueRestaurant('quiet');
    const busyIds = await Promise.all(Array.from({ length: 12 }, () => createPaidCheck(a, busy)));
    const quietId = await createPaidCheck(b, quiet);

    const started = Date.now();
    let quietSyncedAt = 0;
    const deadline = started + 30_000;
    while (Date.now() < deadline) {
      await Promise.all([a.worker.tick(), b.worker.tick()]);
      await Promise.all([a.worker.drain(), b.worker.drain()]);
      if (!quietSyncedAt && (await syncOf(a, quietId)).state === 'synced')
        quietSyncedAt = Date.now();
      const states = await Promise.all(busyIds.map((id) => syncOf(a, id)));
      if (quietSyncedAt && states.every((s) => s.state === 'synced')) break;
      await sleep(25);
    }
    const busyDoneAt = Date.now();
    expect(quietSyncedAt).toBeGreaterThan(0);
    // 12 creates at 5 per window need at least two full windows; the quiet restaurant is not queued behind them.
    expect(busyDoneAt - started).toBeGreaterThanOrEqual(2 * RATE_WINDOW_MS);
    expect(quietSyncedAt - started).toBeLessThan(RATE_WINDOW_MS);
    const rateLimited = await a.db
      .select()
      .from(posSyncAttempts)
      .where(eq(posSyncAttempts.errorKind, 'rate_limited'));
    expect(rateLimited).toHaveLength(0);
  });

  it('a 429 from the POS throttles the restaurant on every instance and is retried', async () => {
    // A POS stricter than our configured budget: we will see real 429s.
    pos.store.reset();
    const strictPos = await startFakePos({ rateLimit: 2 });
    const c = await startApi(strictPos.url, { instanceId: 'api-c' });
    const d = await startApi(strictPos.url, { instanceId: 'api-d' });
    try {
      const restaurant = uniqueRestaurant();
      const ids = await Promise.all(
        Array.from({ length: 6 }, () => createPaidCheck(c, restaurant)),
      );
      const statuses = await settle([c, d], ids, 30_000);
      expect(statuses.every((s) => s.state === 'synced')).toBe(true);
      for (const id of ids) expect(openOrdersFor(strictPos, id)).toHaveLength(1);
      const limited = await c.db
        .select()
        .from(posSyncAttempts)
        .where(eq(posSyncAttempts.errorKind, 'rate_limited'));
      expect(limited.length).toBeGreaterThan(0);
      // 429s are back-pressure, not failures: nothing was parked.
      expect(statuses.every((s) => s.consecutiveFailures === 0)).toBe(true);
    } finally {
      await c.close();
      await d.close();
      await strictPos.close();
    }
  });
});

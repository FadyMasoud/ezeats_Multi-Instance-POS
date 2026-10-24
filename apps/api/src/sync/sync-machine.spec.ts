import { describe, expect, it } from 'vitest';
import {
  type PosError,
  type PosOutcome,
  type RetryPolicy,
  type StepContext,
  type StepResult,
  type SyncSnapshot,
  applyOutcome,
  backoffDelayMs,
  decideStep,
  nextAction,
  stateFor,
} from './sync-machine';

const NOW = new Date('2026-01-01T12:00:00.000Z');
const ctx: StepContext = {
  now: NOW,
  requestStartedAt: null,
  ambiguousSettleMs: 15_000,
  reconcileDelayMs: 2_000,
};
const secondsAgo = (s: number) => new Date(NOW.getTime() - s * 1000);

const fresh: SyncSnapshot = {
  cancelRequested: false,
  posOrderId: null,
  posOrderStatus: null,
  extraOrderIds: [],
  createSentAt: null,
};

const err = (over: Partial<PosError>): PosError => ({
  kind: 'server_error',
  status: 500,
  message: 'boom',
  definitelyNotApplied: true,
  retryAfterMs: null,
  ...over,
});

describe('nextAction', () => {
  it('creates when nothing was ever sent', () => {
    expect(nextAction(fresh)).toEqual({ kind: 'create' });
    expect(stateFor(nextAction(fresh))).toBe('pending');
  });

  it('reconciles instead of creating when a create may already have been sent', () => {
    expect(nextAction({ ...fresh, createSentAt: secondsAgo(1) })).toEqual({ kind: 'lookup' });
  });

  it('is synced once an open POS order is known', () => {
    const s = {
      ...fresh,
      createSentAt: secondsAgo(1),
      posOrderId: 'p1',
      posOrderStatus: 'open' as const,
    };
    expect(nextAction(s)).toEqual({ kind: 'done', state: 'synced' });
  });

  it('suppresses the create entirely when cancelled before any create was sent', () => {
    expect(nextAction({ ...fresh, cancelRequested: true })).toEqual({
      kind: 'done',
      state: 'cancelled',
    });
  });

  it('looks up before cancelling when a create may exist but its id is unknown', () => {
    expect(nextAction({ ...fresh, cancelRequested: true, createSentAt: secondsAgo(1) })).toEqual({
      kind: 'lookup',
    });
  });

  it('only cancels an order id the POS returned (cancel can never precede its create)', () => {
    const s = {
      ...fresh,
      cancelRequested: true,
      createSentAt: secondsAgo(1),
      posOrderId: 'p1',
      posOrderStatus: 'open' as const,
    };
    expect(nextAction(s)).toEqual({ kind: 'cancel', posOrderId: 'p1', reason: 'cancel_requested' });
  });

  it('is cancelled once the POS order is cancelled', () => {
    const s = {
      ...fresh,
      cancelRequested: true,
      posOrderId: 'p1',
      posOrderStatus: 'cancelled' as const,
    };
    expect(nextAction(s)).toEqual({ kind: 'done', state: 'cancelled' });
  });

  it('cancels known duplicates before anything else', () => {
    const s = {
      ...fresh,
      posOrderId: 'p1',
      posOrderStatus: 'open' as const,
      extraOrderIds: ['p2', 'p3'],
    };
    expect(nextAction(s)).toEqual({ kind: 'cancel', posOrderId: 'p2', reason: 'duplicate' });
  });
});

describe('applyOutcome: create', () => {
  const create = { kind: 'create' } as const;
  const sent = { ...fresh, createSentAt: secondsAgo(0) };

  it('records the order on success', () => {
    const r = applyOutcome(sent, create, { action: 'create', ok: true, posOrderId: 'p1' }, ctx);
    expect(r.failure).toBeNull();
    expect(r.snapshot).toMatchObject({ posOrderId: 'p1', posOrderStatus: 'open' });
    expect(nextAction(r.snapshot)).toEqual({ kind: 'done', state: 'synced' });
  });

  it.each([
    ['500', err({ kind: 'server_error', status: 500 })],
    ['429', err({ kind: 'rate_limited', status: 429, retryAfterMs: 4_000 })],
    ['422', err({ kind: 'rejected', status: 422 })],
    ['connection refused', err({ kind: 'network', status: null })],
  ])('clears createSentAt when the POS guarantees nothing was created (%s)', (_, error) => {
    const r = applyOutcome(sent, create, { action: 'create', ok: false, error }, ctx);
    expect(r.snapshot.createSentAt).toBeNull();
    expect(nextAction(r.snapshot)).toEqual({ kind: 'create' });
  });

  it.each([
    ['timeout', err({ kind: 'timeout', status: null, definitelyNotApplied: false })],
    ['connection reset', err({ kind: 'network', status: null, definitelyNotApplied: false })],
    ['502 from a proxy', err({ kind: 'server_error', status: 502, definitelyNotApplied: false })],
  ])('keeps createSentAt and reconciles when the outcome is unknown (%s)', (_, error) => {
    const r = applyOutcome(sent, create, { action: 'create', ok: false, error }, ctx);
    expect(r.snapshot.createSentAt).toEqual(sent.createSentAt);
    expect(nextAction(r.snapshot)).toEqual({ kind: 'lookup' });
    expect(r.delayMs).toBe(ctx.reconcileDelayMs);
  });

  it('marks 422 as permanent and 429 as not consuming the retry budget', () => {
    const rejected = applyOutcome(
      sent,
      create,
      { action: 'create', ok: false, error: err({ kind: 'rejected', status: 422 }) },
      ctx,
    );
    expect(rejected.failure).toMatchObject({ permanent: true, countsTowardLimit: true });
    const limited = applyOutcome(
      sent,
      create,
      {
        action: 'create',
        ok: false,
        error: err({ kind: 'rate_limited', status: 429, retryAfterMs: 4_000 }),
      },
      ctx,
    );
    expect(limited.failure).toMatchObject({ permanent: false, countsTowardLimit: false });
    expect(limited.delayMs).toBe(4_000);
  });
});

describe('applyOutcome: lookup', () => {
  const lookup = { kind: 'lookup' } as const;
  const order = (posOrderId: string, status: 'open' | 'cancelled', createdAt: string) => ({
    posOrderId,
    status,
    createdAt,
  });
  const found = (orders: ReturnType<typeof order>[]): PosOutcome => ({
    action: 'lookup',
    ok: true,
    orders,
  });

  it('adopts the order created by a timed-out request', () => {
    const s = { ...fresh, createSentAt: secondsAgo(3) };
    const r = applyOutcome(s, lookup, found([order('p1', 'open', 'a')]), ctx);
    expect(r.snapshot).toMatchObject({
      posOrderId: 'p1',
      posOrderStatus: 'open',
      extraOrderIds: [],
    });
    expect(nextAction(r.snapshot)).toEqual({ kind: 'done', state: 'synced' });
  });

  it('keeps the oldest open order and queues the rest for cancellation', () => {
    const s = { ...fresh, createSentAt: secondsAgo(3) };
    const r = applyOutcome(
      s,
      lookup,
      found([order('p2', 'open', 'b'), order('p1', 'open', 'a'), order('p3', 'cancelled', 'c')]),
      ctx,
    );
    expect(r.snapshot.posOrderId).toBe('p1');
    expect(r.snapshot.extraOrderIds).toEqual(['p2']);
    expect(nextAction(r.snapshot)).toEqual({
      kind: 'cancel',
      posOrderId: 'p2',
      reason: 'duplicate',
    });
  });

  it('does not trust an empty result inside the settle window', () => {
    const s = { ...fresh, createSentAt: secondsAgo(5) };
    const r = applyOutcome(s, lookup, found([]), ctx);
    expect(r.snapshot.createSentAt).toEqual(s.createSentAt);
    expect(r.failure).toBeNull();
    expect(r.delayMs).toBe(10_000);
  });

  it('allows a fresh create once an empty result is older than the settle window', () => {
    const s = { ...fresh, createSentAt: secondsAgo(20) };
    const r = applyOutcome(s, lookup, found([]), ctx);
    expect(r.snapshot.createSentAt).toBeNull();
    expect(nextAction(r.snapshot)).toEqual({ kind: 'create' });
  });

  it('finishes a cancel whose create never landed without touching the POS again', () => {
    const s = { ...fresh, cancelRequested: true, createSentAt: secondsAgo(20) };
    const r = applyOutcome(s, lookup, found([]), ctx);
    expect(nextAction(r.snapshot)).toEqual({ kind: 'done', state: 'cancelled' });
  });

  it('cancels the order a timed-out create produced when the check was cancelled meanwhile', () => {
    const s = { ...fresh, cancelRequested: true, createSentAt: secondsAgo(3) };
    const r = applyOutcome(s, lookup, found([order('p1', 'open', 'a')]), ctx);
    expect(nextAction(r.snapshot)).toEqual({
      kind: 'cancel',
      posOrderId: 'p1',
      reason: 'cancel_requested',
    });
  });

  it('recognises an already-cancelled order when the cancel response was lost', () => {
    const s = { ...fresh, cancelRequested: true, createSentAt: secondsAgo(3) };
    const r = applyOutcome(s, lookup, found([order('p1', 'cancelled', 'a')]), ctx);
    expect(nextAction(r.snapshot)).toEqual({ kind: 'done', state: 'cancelled' });
  });

  it('retries a failed lookup without changing what is known', () => {
    const s = { ...fresh, createSentAt: secondsAgo(3) };
    const r = applyOutcome(
      s,
      lookup,
      {
        action: 'lookup',
        ok: false,
        error: err({ kind: 'timeout', status: null, definitelyNotApplied: false }),
      },
      ctx,
    );
    expect(r.snapshot).toEqual(s);
    expect(r.failure).toMatchObject({ kind: 'timeout', permanent: false });
  });
});

describe('applyOutcome: cancel', () => {
  it('marks the order cancelled', () => {
    const s = {
      ...fresh,
      cancelRequested: true,
      posOrderId: 'p1',
      posOrderStatus: 'open' as const,
    };
    const r = applyOutcome(
      s,
      { kind: 'cancel', posOrderId: 'p1', reason: 'cancel_requested' },
      { action: 'cancel', ok: true },
      ctx,
    );
    expect(nextAction(r.snapshot)).toEqual({ kind: 'done', state: 'cancelled' });
  });

  it('removes a cancelled duplicate and keeps the main order', () => {
    const s = {
      ...fresh,
      posOrderId: 'p1',
      posOrderStatus: 'open' as const,
      extraOrderIds: ['p2'],
    };
    const r = applyOutcome(
      s,
      { kind: 'cancel', posOrderId: 'p2', reason: 'duplicate' },
      { action: 'cancel', ok: true },
      ctx,
    );
    expect(r.snapshot.extraOrderIds).toEqual([]);
    expect(nextAction(r.snapshot)).toEqual({ kind: 'done', state: 'synced' });
  });

  it('keeps cancelling after a transient error (cancel is idempotent)', () => {
    const s = {
      ...fresh,
      cancelRequested: true,
      posOrderId: 'p1',
      posOrderStatus: 'open' as const,
    };
    const action = { kind: 'cancel', posOrderId: 'p1', reason: 'cancel_requested' } as const;
    const r = applyOutcome(s, action, { action: 'cancel', ok: false, error: err({}) }, ctx);
    expect(nextAction(r.snapshot)).toEqual(action);
  });
});

describe('settle window is measured from when the lookup was sent (review S1)', () => {
  const lookup = { kind: 'lookup' } as const;
  const empty: PosOutcome = { action: 'lookup', ok: true, orders: [] };

  it('a slow empty lookup that started inside the window does not clear createSentAt', () => {
    // create sent at t=1, lookup sent at t=13 (inside 15 s), response processed at t=16
    const s = { ...fresh, createSentAt: secondsAgo(15) };
    const r = applyOutcome(s, lookup, empty, { ...ctx, requestStartedAt: secondsAgo(3) });
    expect(r.snapshot.createSentAt).toEqual(s.createSentAt);
    expect(nextAction(r.snapshot)).toEqual({ kind: 'lookup' });
    expect(r.delayMs).toBe(0); // window has passed by now: look again right away
  });

  it('an empty lookup sent after the window clears createSentAt', () => {
    const s = { ...fresh, createSentAt: secondsAgo(20) };
    const r = applyOutcome(s, lookup, empty, { ...ctx, requestStartedAt: secondsAgo(4) });
    expect(r.snapshot.createSentAt).toBeNull();
  });
});

describe('ambiguous 4xx keeps the create "maybe sent" (review B1)', () => {
  const create = { kind: 'create' } as const;
  const sent = { ...fresh, createSentAt: secondsAgo(1) };
  const outcome: PosOutcome = {
    action: 'create',
    ok: false,
    error: err({ kind: 'rejected', status: 408, definitelyNotApplied: false }),
  };

  it('parks as failed but a later cancel or retry looks the order up first', () => {
    const r = applyOutcome(sent, create, outcome, ctx);
    expect(r.snapshot.createSentAt).toEqual(sent.createSentAt);
    expect(decideStep(0, create, r, policy).state).toBe('failed');
    expect(nextAction({ ...r.snapshot, cancelRequested: true })).toEqual({ kind: 'lookup' });
    expect(nextAction(r.snapshot)).toEqual({ kind: 'lookup' });
  });
});

const policy: RetryPolicy = {
  maxConsecutiveFailures: 3,
  backoffBaseMs: 1_000,
  backoffMaxMs: 30_000,
};

describe('decideStep (retry policy)', () => {
  const create = { kind: 'create' } as const;
  const result = (failure: StepResult['failure'], snapshot = fresh, delayMs = 0): StepResult => ({
    snapshot,
    delayMs,
    failure,
  });
  const failure = (over: Partial<NonNullable<StepResult['failure']>>) => ({
    kind: 'server_error' as const,
    status: 500,
    message: 'boom',
    permanent: false,
    countsTowardLimit: true,
    ...over,
  });

  it('resets the failure count on success', () => {
    const d = decideStep(
      2,
      create,
      result(null, { ...fresh, posOrderId: 'p', posOrderStatus: 'open' }),
      policy,
    );
    expect(d).toMatchObject({ state: 'synced', consecutiveFailures: 0, error: null });
  });

  it('backs off on transient failures and stops when the budget is exhausted', () => {
    const d1 = decideStep(0, create, result(failure({})), policy, () => 1);
    expect(d1).toMatchObject({ state: 'pending', consecutiveFailures: 1, delayMs: 1_000 });
    const d3 = decideStep(2, create, result(failure({})), policy);
    expect(d3.state).toBe('failed');
    expect(d3.error?.kind).toBe('retries_exhausted');
    expect(d3.error?.message).toMatch(/server_error: boom/);
  });

  it('stops immediately on a permanent rejection and keeps its category', () => {
    const d = decideStep(
      0,
      create,
      result(failure({ kind: 'rejected', status: 422, permanent: true })),
      policy,
    );
    expect(d).toMatchObject({ state: 'failed', error: { kind: 'rejected', status: 422 } });
  });

  it('rate limiting neither consumes the budget nor parks the sync', () => {
    const d = decideStep(
      2,
      create,
      result(
        failure({ kind: 'rate_limited', status: 429, countsTowardLimit: false }),
        fresh,
        4_000,
      ),
      policy,
    );
    expect(d).toMatchObject({ state: 'pending', consecutiveFailures: 2, delayMs: 4_000 });
  });

  it('never parks a step whose next action is done (e.g. 422 on a check cancelled meanwhile)', () => {
    const d = decideStep(
      0,
      create,
      result(failure({ kind: 'rejected', status: 422, permanent: true }), {
        ...fresh,
        cancelRequested: true,
      }),
      policy,
    );
    expect(d.state).toBe('cancelled');
  });

  it('names the duplicate when cancelling it fails', () => {
    const cancelDup = { kind: 'cancel', posOrderId: 'p2', reason: 'duplicate' } as const;
    const snapshot = {
      ...fresh,
      posOrderId: 'p1',
      posOrderStatus: 'open' as const,
      extraOrderIds: ['p2'],
    };
    const d = decideStep(
      0,
      cancelDup,
      result(failure({ kind: 'rejected', status: 404, permanent: true }), snapshot),
      policy,
    );
    expect(d.state).toBe('failed');
    expect(d.error?.message).toMatch(/duplicate POS order p2/);
  });
});

describe('backoffDelayMs', () => {
  it('grows exponentially, is capped, and stays within [exp/2, exp]', () => {
    expect(backoffDelayMs(1, 1_000, 30_000, () => 0)).toBe(500);
    expect(backoffDelayMs(1, 1_000, 30_000, () => 1)).toBe(1_000);
    expect(backoffDelayMs(4, 1_000, 30_000, () => 1)).toBe(8_000);
    expect(backoffDelayMs(20, 1_000, 30_000, () => 1)).toBe(30_000);
    expect(backoffDelayMs(20, 1_000, 30_000, () => 0)).toBe(15_000);
  });
});

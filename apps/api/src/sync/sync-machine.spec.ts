import { describe, expect, it } from 'vitest';
import {
  type PosError,
  type PosOutcome,
  type StepContext,
  type SyncSnapshot,
  applyOutcome,
  backoffDelayMs,
  nextAction,
  stateFor,
} from './sync-machine';

const NOW = new Date('2026-01-01T12:00:00.000Z');
const ctx: StepContext = { now: NOW, ambiguousSettleMs: 15_000, reconcileDelayMs: 2_000 };
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

describe('backoffDelayMs', () => {
  it('grows exponentially, is capped, and stays within [exp/2, exp]', () => {
    expect(backoffDelayMs(1, 1_000, 30_000, () => 0)).toBe(500);
    expect(backoffDelayMs(1, 1_000, 30_000, () => 1)).toBe(1_000);
    expect(backoffDelayMs(4, 1_000, 30_000, () => 1)).toBe(8_000);
    expect(backoffDelayMs(20, 1_000, 30_000, () => 1)).toBe(30_000);
    expect(backoffDelayMs(20, 1_000, 30_000, () => 0)).toBe(15_000);
  });
});

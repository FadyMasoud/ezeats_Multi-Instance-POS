import type { PosErrorKind, SyncState } from '../db/schema';

/**
 * Pure decision logic for one check's POS sync. No I/O: the worker feeds it a fresh snapshot
 * (read under a row lock) and the outcome of at most one POS request, and persists the result.
 *
 * Invariants this encodes:
 *  - A cancel is only ever sent for a posOrderId the POS itself returned, so a cancel can never
 *    reach the POS before the create it cancels.
 *  - A create is only sent when createSentAt is null. createSentAt is set (and committed) before
 *    the request goes out and is cleared only when the POS proves nothing was created: a response
 *    that by contract creates nothing (500/429/422), a refused connection, or an empty
 *    externalRef lookup older than the settle window.
 */

export interface SyncSnapshot {
  cancelRequested: boolean;
  posOrderId: string | null;
  posOrderStatus: 'open' | 'cancelled' | null;
  extraOrderIds: string[];
  createSentAt: Date | null;
}

export type CancelReason = 'cancel_requested' | 'duplicate';

export type NextAction =
  | { kind: 'create' }
  | { kind: 'lookup' }
  | { kind: 'cancel'; posOrderId: string; reason: CancelReason }
  | { kind: 'done'; state: 'synced' | 'cancelled' };

export type PosAction = Exclude<NextAction, { kind: 'done' }>;

export function nextAction(s: SyncSnapshot): NextAction {
  const duplicate = s.extraOrderIds[0];
  if (duplicate !== undefined)
    return { kind: 'cancel', posOrderId: duplicate, reason: 'duplicate' };

  if (s.cancelRequested) {
    if (s.posOrderId !== null) {
      return s.posOrderStatus === 'cancelled'
        ? { kind: 'done', state: 'cancelled' }
        : { kind: 'cancel', posOrderId: s.posOrderId, reason: 'cancel_requested' };
    }
    // Cancelled before any create was sent: nothing can exist on the POS, so suppress the create.
    if (s.createSentAt === null) return { kind: 'done', state: 'cancelled' };
    return { kind: 'lookup' };
  }

  if (s.posOrderId !== null && s.posOrderStatus === 'open')
    return { kind: 'done', state: 'synced' };
  if (s.createSentAt === null) return { kind: 'create' };
  return { kind: 'lookup' };
}

/** The persisted state column is a projection of the next action. */
export function stateFor(action: NextAction): Exclude<SyncState, 'failed'> {
  switch (action.kind) {
    case 'create':
      return 'pending';
    case 'lookup':
      return 'reconciling';
    case 'cancel':
      return 'cancelling';
    case 'done':
      return action.state;
  }
}

export interface PosOrderSummary {
  posOrderId: string;
  status: 'open' | 'cancelled';
  createdAt: string;
}

export interface PosError {
  kind: Exclude<PosErrorKind, 'retries_exhausted'>;
  status: number | null;
  message: string;
  /** True only when the POS contract guarantees the request had no effect. */
  definitelyNotApplied: boolean;
  retryAfterMs: number | null;
}

export type PosOutcome =
  | { action: 'create'; ok: true; posOrderId: string }
  | { action: 'lookup'; ok: true; orders: PosOrderSummary[] }
  | { action: 'cancel'; ok: true }
  | { action: PosAction['kind']; ok: false; error: PosError };

export interface StepFailure {
  kind: Exclude<PosErrorKind, 'retries_exhausted'>;
  status: number | null;
  message: string;
  /** Permanent rejections stop automatic retries immediately. */
  permanent: boolean;
  /** Rate limiting is expected back-pressure and does not consume the retry budget. */
  countsTowardLimit: boolean;
}

export interface StepResult {
  snapshot: SyncSnapshot;
  /** Requested delay before the next step; the caller replaces it with backoff for failures. */
  delayMs: number;
  failure: StepFailure | null;
}

export interface StepContext {
  now: Date;
  /**
   * DB clock just before the request was sent (end of beginStep). An empty lookup describes the
   * POS when it read its store, which is no later than when we finish, so the settle age must be
   * measured from here, not from `now` (a slow lookup response must not "age" the evidence).
   */
  requestStartedAt: Date | null;
  ambiguousSettleMs: number;
  reconcileDelayMs: number;
}

export function applyOutcome(
  s: SyncSnapshot,
  action: PosAction,
  outcome: PosOutcome,
  ctx: StepContext,
): StepResult {
  if (!outcome.ok) return applyError(s, action, outcome.error, ctx);

  switch (outcome.action) {
    case 'create':
      return ok({ ...s, posOrderId: outcome.posOrderId, posOrderStatus: 'open' });

    case 'cancel':
      if (action.kind === 'cancel' && action.reason === 'duplicate') {
        return ok({
          ...s,
          extraOrderIds: s.extraOrderIds.filter((id) => id !== action.posOrderId),
        });
      }
      return ok({ ...s, posOrderStatus: 'cancelled' });

    case 'lookup':
      return applyLookup(s, outcome.orders, ctx);
  }
}

function applyLookup(s: SyncSnapshot, orders: PosOrderSummary[], ctx: StepContext): StepResult {
  const sorted = [...orders].sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.posOrderId.localeCompare(b.posOrderId),
  );
  const open = sorted.filter((o) => o.status === 'open');
  const [keep, ...duplicates] = open;

  if (keep) {
    const extras = new Set([...s.extraOrderIds, ...duplicates.map((o) => o.posOrderId)]);
    return ok({
      ...s,
      posOrderId: keep.posOrderId,
      posOrderStatus: 'open',
      extraOrderIds: [...extras],
    });
  }

  const cancelledOrder = sorted[0];
  if (s.cancelRequested && cancelledOrder) {
    // Our create landed and was already cancelled (e.g. the cancel response was lost).
    return ok({ ...s, posOrderId: cancelledOrder.posOrderId, posOrderStatus: 'cancelled' });
  }

  const sentAt = s.createSentAt?.getTime() ?? 0;
  const observedAt = (ctx.requestStartedAt ?? ctx.now).getTime();
  const age = observedAt - sentAt;
  if (age >= ctx.ambiguousSettleMs) {
    // Nothing open under our externalRef long after the last create could have landed:
    // treat the create as not applied. A fresh create is now safe (or, if cancelled, nothing to do).
    return ok({ ...s, createSentAt: null, posOrderId: null, posOrderStatus: null });
  }
  // Too early to trust an empty result; look again once the settle window has passed.
  const remaining = ctx.ambiguousSettleMs - age - (ctx.now.getTime() - observedAt);
  return { snapshot: s, delayMs: Math.max(0, remaining), failure: null };
}

function applyError(
  s: SyncSnapshot,
  action: PosAction,
  error: PosError,
  ctx: StepContext,
): StepResult {
  const rateLimited = error.kind === 'rate_limited';
  const permanent = error.kind === 'rejected';
  const failure: StepFailure = {
    kind: error.kind,
    status: error.status,
    message: error.message,
    permanent,
    countsTowardLimit: !rateLimited,
  };

  if (action.kind === 'create') {
    if (error.definitelyNotApplied) {
      return { snapshot: { ...s, createSentAt: null }, delayMs: error.retryAfterMs ?? 0, failure };
    }
    // Outcome unknown (timeout, dropped connection, unexpected status): keep createSentAt so the
    // next step reconciles by externalRef instead of blindly creating again.
    return { snapshot: s, delayMs: ctx.reconcileDelayMs, failure };
  }

  // Lookups are read-only and cancels are idempotent on the POS, so both are safe to repeat.
  return { snapshot: s, delayMs: error.retryAfterMs ?? 0, failure };
}

function ok(snapshot: SyncSnapshot): StepResult {
  return { snapshot, delayMs: 0, failure: null };
}

export interface RetryPolicy {
  maxConsecutiveFailures: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
}

export interface StepDecision {
  snapshot: SyncSnapshot;
  state: SyncState;
  consecutiveFailures: number;
  delayMs: number;
  /** Error to record as last_error (null on success; the previous one is then kept). */
  error: { kind: PosErrorKind; status: number | null; message: string } | null;
}

/**
 * Turns a step result into what gets persisted: failure counting, backoff, and when to stop.
 * A step whose next action is "done" never parks as failed, even if the call itself failed
 * (e.g. a 422 create on a check that was cancelled meanwhile simply ends cancelled).
 */
export function decideStep(
  previousFailures: number,
  action: PosAction,
  result: StepResult,
  policy: RetryPolicy,
  random: () => number = Math.random,
): StepDecision {
  const next = nextAction(result.snapshot);
  const { failure } = result;
  if (!failure) {
    return {
      snapshot: result.snapshot,
      state: stateFor(next),
      consecutiveFailures: 0,
      delayMs: result.delayMs,
      error: null,
    };
  }

  const consecutiveFailures = previousFailures + (failure.countsTowardLimit ? 1 : 0);
  const delayMs = failure.countsTowardLimit
    ? Math.max(
        result.delayMs,
        backoffDelayMs(consecutiveFailures, policy.backoffBaseMs, policy.backoffMaxMs, random),
      )
    : result.delayMs;
  // Name the duplicate so an operator can see the main order is fine but an extra one is open.
  const context =
    action.kind === 'cancel' && action.reason === 'duplicate'
      ? `Could not cancel duplicate POS order ${action.posOrderId}: `
      : '';
  let error: StepDecision['error'] = {
    kind: failure.kind,
    status: failure.status,
    message: `${context}${failure.message}`,
  };
  let state: SyncState = stateFor(next);

  const exhausted = consecutiveFailures >= policy.maxConsecutiveFailures;
  if (next.kind !== 'done' && (failure.permanent || exhausted)) {
    state = 'failed';
    if (!failure.permanent) {
      error = {
        kind: 'retries_exhausted',
        status: failure.status,
        message: `Gave up after ${consecutiveFailures} consecutive failures. Last: ${failure.kind}: ${error.message}`,
      };
    }
  }
  return { snapshot: result.snapshot, state, consecutiveFailures, delayMs, error };
}

/** Exponential backoff with "equal jitter": half fixed, half random, capped. */
export function backoffDelayMs(
  consecutiveFailures: number,
  baseMs: number,
  maxMs: number,
  random: () => number = Math.random,
): number {
  const exp = Math.min(maxMs, baseMs * 2 ** Math.max(0, consecutiveFailures - 1));
  return Math.round(exp / 2 + random() * (exp / 2));
}

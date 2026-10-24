import { Inject, Injectable, Logger } from '@nestjs/common';
import { asc, eq, sql } from 'drizzle-orm';
import { APP_CONFIG, AppConfig } from '../config';
import { Database, Tx, WORKER_DB } from '../db/database';
import { PosSyncRow, SyncState, checkItems, checks, posSync, posSyncAttempts } from '../db/schema';
import { PosClient } from './pos-client';
import { PosRateLimiter } from './rate-limiter';
import {
  NextAction,
  PosAction,
  PosOutcome,
  SyncSnapshot,
  applyOutcome,
  decideStep,
  nextAction,
  stateFor,
} from './sync-machine';

export interface Claim {
  checkId: string;
  leaseToken: string;
}

type Begin =
  | { kind: 'skip'; reason: string }
  | {
      kind: 'call';
      action: PosAction;
      row: PosSyncRow;
      payload: CreatePayload | null;
      /** DB clock at the end of beginStep, i.e. no later than the request leaving. */
      requestStartedAt: Date;
    };

interface CreatePayload {
  externalRef: string;
  restaurantId: string;
  items: { name: string; quantity: number; unitPrice: number }[];
  total: number;
}

export function toSnapshot(row: PosSyncRow): SyncSnapshot {
  return {
    cancelRequested: row.cancelRequested,
    posOrderId: row.posOrderId,
    posOrderStatus: row.posOrderStatus,
    extraOrderIds: row.extraOrderIds,
    createSentAt: row.createSentAt,
  };
}

/** Columns that mirror a snapshot, plus the timestamps implied by the resulting state. */
export function snapshotColumns(s: SyncSnapshot, action: NextAction) {
  return stateColumns(s, stateFor(action));
}

function stateColumns(s: SyncSnapshot, state: SyncState) {
  return {
    state,
    cancelRequested: s.cancelRequested,
    posOrderId: s.posOrderId,
    posOrderStatus: s.posOrderStatus,
    extraOrderIds: s.extraOrderIds,
    createSentAt: s.createSentAt,
    ...(state === 'synced' ? { syncedAt: sql`COALESCE(${posSync.syncedAt}, now())` } : {}),
    completedAt: state === 'synced' || state === 'cancelled' ? sql`now()` : null,
  };
}

const RELEASE_LEASE = { leaseOwner: null, leaseToken: null, leaseUntil: null } as const;

/**
 * Executes one step of one check's sync: at most one POS request per call.
 * No database transaction is held open while the POS request is in flight.
 */
@Injectable()
export class SyncProcessor {
  private readonly logger = new Logger(SyncProcessor.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(WORKER_DB) private readonly db: Database,
    private readonly pos: PosClient,
    private readonly rateLimiter: PosRateLimiter,
  ) {}

  /**
   * Leases due rows. At most one row per restaurant per claim (fairness: a restaurant with a deep
   * backlog cannot crowd out others), and throttled restaurants are skipped entirely.
   */
  async claimDue(limit: number): Promise<Claim[]> {
    if (limit <= 0) return [];
    const result = await this.db.execute<{ check_id: string; lease_token: string }>(sql`
      WITH ranked AS (
        SELECT s.check_id, s.next_attempt_at,
               row_number() OVER (PARTITION BY s.restaurant_id ORDER BY s.next_attempt_at, s.check_id) AS rn
        FROM pos_sync s
        WHERE s.state IN ('pending', 'reconciling', 'cancelling')
          AND s.next_attempt_at <= now()
          AND (s.lease_until IS NULL OR s.lease_until < now())
          AND NOT EXISTS (
            SELECT 1 FROM pos_restaurant_throttle t
            WHERE t.restaurant_id = s.restaurant_id AND t.blocked_until > now())
      ),
      picked AS (
        SELECT s.check_id
        FROM pos_sync s
        JOIN ranked r ON r.check_id = s.check_id AND r.rn = 1
        WHERE s.state IN ('pending', 'reconciling', 'cancelling')
          AND s.next_attempt_at <= now()
          AND (s.lease_until IS NULL OR s.lease_until < now())
        ORDER BY r.next_attempt_at
        LIMIT ${limit}
        FOR UPDATE OF s SKIP LOCKED
      )
      UPDATE pos_sync s
      SET lease_owner = ${this.config.instanceId},
          lease_token = gen_random_uuid(),
          lease_until = now() + make_interval(secs => ${this.config.worker.leaseMs / 1000}),
          updated_at = now()
      FROM picked
      WHERE s.check_id = picked.check_id
      RETURNING s.check_id, s.lease_token`);
    return result.rows.map((r) => ({ checkId: r.check_id, leaseToken: r.lease_token }));
  }

  async process(claim: Claim): Promise<void> {
    const begin = await this.db.transaction((tx) => this.beginStep(tx, claim));
    if (begin.kind === 'skip') {
      this.logger.debug(`check ${claim.checkId}: ${begin.reason}`);
      return;
    }

    const startedAt = new Date();
    const outcome = await this.execute(begin.action, begin.row, begin.payload);
    const finishedAt = new Date();

    await this.db.transaction((tx) =>
      this.finishStep(tx, claim, begin, outcome, startedAt, finishedAt),
    );
  }

  private async lockOwned(tx: Tx, claim: Claim): Promise<{ row: PosSyncRow; now: Date } | null> {
    const [row] = await tx
      .select()
      .from(posSync)
      .where(eq(posSync.checkId, claim.checkId))
      .for('update');
    if (!row || row.leaseToken !== claim.leaseToken) return null;
    const clock = await tx.execute<{ now: Date }>(sql`SELECT clock_timestamp() AS now`);
    return { row, now: new Date(clock.rows[0]?.now ?? Date.now()) };
  }

  private async beginStep(tx: Tx, claim: Claim): Promise<Begin> {
    const owned = await this.lockOwned(tx, claim);
    if (!owned) return { kind: 'skip', reason: 'lease lost before start' };
    const { row } = owned;

    const action = nextAction(toSnapshot(row));
    if (action.kind === 'done') {
      await tx
        .update(posSync)
        .set({
          ...snapshotColumns(toSnapshot(row), action),
          ...RELEASE_LEASE,
          updatedAt: sql`now()`,
        })
        .where(eq(posSync.checkId, row.checkId));
      return { kind: 'skip', reason: `already ${action.state}` };
    }

    const decision = await this.rateLimiter.tryAcquire(tx, row.restaurantId);
    if (!decision.allowed) {
      await tx
        .update(posSync)
        .set({
          state: stateFor(action),
          nextAttemptAt: decision.retryAt,
          ...RELEASE_LEASE,
          updatedAt: sql`now()`,
        })
        .where(eq(posSync.checkId, row.checkId));
      return { kind: 'skip', reason: `restaurant ${row.restaurantId} throttled` };
    }

    const payload = action.kind === 'create' ? await this.loadCreatePayload(tx, row) : null;

    // For a create, committing create_sent_at *before* the request is what makes a crash or
    // timeout recoverable: whoever touches this row next knows it must reconcile first.
    // clock_timestamp() (not now(), the transaction start) so the settle window is measured from
    // as close to the request leaving as possible; this is the last statement before commit.
    const [stamped] = await tx
      .update(posSync)
      .set({
        state: stateFor(action),
        ...(action.kind === 'create' ? { createSentAt: sql`clock_timestamp()` } : {}),
        attemptCount: sql`${posSync.attemptCount} + 1`,
        lastAttemptAt: sql`clock_timestamp()`,
        updatedAt: sql`now()`,
      })
      .where(eq(posSync.checkId, row.checkId))
      .returning({ requestStartedAt: posSync.lastAttemptAt });

    return {
      kind: 'call',
      action,
      row,
      payload,
      requestStartedAt: stamped?.requestStartedAt ?? new Date(),
    };
  }

  private async loadCreatePayload(tx: Tx, row: PosSyncRow): Promise<CreatePayload> {
    const [check] = await tx.select().from(checks).where(eq(checks.id, row.checkId));
    const items = await tx
      .select()
      .from(checkItems)
      .where(eq(checkItems.checkId, row.checkId))
      .orderBy(asc(checkItems.position));
    if (!check) throw new Error(`check ${row.checkId} missing for sync row`);
    return {
      externalRef: row.externalRef,
      restaurantId: row.restaurantId,
      items: items.map((i) => ({
        name: i.name,
        quantity: i.quantity,
        unitPrice: Number(i.unitPrice),
      })),
      total: Number(check.total),
    };
  }

  private execute(
    action: PosAction,
    row: PosSyncRow,
    payload: CreatePayload | null,
  ): Promise<PosOutcome> {
    switch (action.kind) {
      case 'create':
        if (!payload) throw new Error('create without payload');
        return this.pos.createOrder(payload);
      case 'lookup':
        return this.pos.findOrders(row.externalRef);
      case 'cancel':
        return this.pos.cancelOrder(action.posOrderId);
    }
  }

  private async finishStep(
    tx: Tx,
    claim: Claim,
    begin: Extract<Begin, { kind: 'call' }>,
    outcome: PosOutcome,
    startedAt: Date,
    finishedAt: Date,
  ): Promise<void> {
    const { action, row: startRow } = begin;
    // The attempt happened regardless of who owns the row now; always record it.
    await tx.insert(posSyncAttempts).values({
      checkId: claim.checkId,
      operation: action.kind,
      ok: outcome.ok,
      errorKind: outcome.ok ? null : outcome.error.kind,
      httpStatus: outcome.ok ? null : outcome.error.status,
      message: describeOutcome(action, outcome),
      posOrderId:
        action.kind === 'cancel'
          ? action.posOrderId
          : outcome.ok && outcome.action === 'create'
            ? outcome.posOrderId
            : null,
      instanceId: this.config.instanceId,
      startedAt,
      finishedAt,
    });

    if (!outcome.ok && outcome.error.kind === 'rate_limited') {
      await this.rateLimiter.markRateLimited(
        tx,
        startRow.restaurantId,
        outcome.error.retryAfterMs ?? this.config.rateLimit.windowMs,
      );
    }

    const owned = await this.lockOwned(tx, claim);
    if (!owned) {
      // Lease expired and another instance took over. Its next step reconciles by externalRef,
      // so dropping this result cannot cause a duplicate; it only costs one extra lookup.
      this.logger.warn(
        `check ${claim.checkId}: lease lost during ${action.kind}; result discarded`,
      );
      return;
    }
    const { row, now } = owned;
    const w = this.config.worker;

    // Apply to the *fresh* row: a cancel may have been requested while the request was in flight.
    const result = applyOutcome(toSnapshot(row), action, outcome, {
      now,
      requestStartedAt: begin.requestStartedAt,
      ambiguousSettleMs: w.ambiguousSettleMs,
      reconcileDelayMs: w.reconcileDelayMs,
    });
    const decision = decideStep(row.consecutiveFailures, action, result, w);
    if (decision.state === 'failed') {
      this.logger.warn(`check ${claim.checkId}: sync stopped (${decision.error?.message})`);
    }

    await tx
      .update(posSync)
      .set({
        ...stateColumns(decision.snapshot, decision.state),
        ...(decision.error
          ? {
              lastErrorKind: decision.error.kind,
              lastErrorMessage: decision.error.message,
              lastErrorStatus: decision.error.status,
              lastErrorAt: sql`now()`,
            }
          : {}),
        consecutiveFailures: decision.consecutiveFailures,
        nextAttemptAt: sql`now() + make_interval(secs => ${decision.delayMs / 1000})`,
        ...RELEASE_LEASE,
        updatedAt: sql`now()`,
      })
      .where(eq(posSync.checkId, claim.checkId));
  }
}

function describeOutcome(action: PosAction, outcome: PosOutcome): string {
  if (!outcome.ok) return outcome.error.message;
  switch (outcome.action) {
    case 'create':
      return `created POS order ${outcome.posOrderId}`;
    case 'lookup': {
      const open = outcome.orders.filter((o) => o.status === 'open').length;
      return `found ${outcome.orders.length} order(s), ${open} open`;
    }
    case 'cancel':
      return action.kind === 'cancel' && action.reason === 'duplicate'
        ? `cancelled duplicate POS order ${action.posOrderId}`
        : `cancelled POS order ${action.kind === 'cancel' ? action.posOrderId : ''}`;
  }
}

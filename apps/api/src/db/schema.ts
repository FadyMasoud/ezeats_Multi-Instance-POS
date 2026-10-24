import { sql } from 'drizzle-orm';
import {
  bigserial,
  boolean,
  check,
  index,
  integer,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

const tz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const checkStatusEnum = pgEnum('check_status', ['open', 'paid', 'cancelled']);

/**
 * Stored projection of "what the worker must do next" for one check.
 * pending     -> a POS create is needed and has never been (or provably was not) sent
 * reconciling -> a create may have reached the POS; we must look it up by externalRef before acting
 * cancelling  -> the POS order is known and must be cancelled
 * synced      -> terminal while the check stays paid: exactly one open POS order is known
 * cancelled   -> terminal: the POS has no open order for this check
 * failed      -> stopped (422 or retry budget exhausted); only a manual retry or a cancel resumes it
 */
export const syncStateEnum = pgEnum('pos_sync_state', [
  'pending',
  'reconciling',
  'cancelling',
  'synced',
  'cancelled',
  'failed',
]);

export const posOperationEnum = pgEnum('pos_operation', ['create', 'lookup', 'cancel']);

export const posErrorKindEnum = pgEnum('pos_error_kind', [
  'server_error',
  'rate_limited',
  'rejected',
  'timeout',
  'network',
  'unexpected',
  'retries_exhausted',
]);

export const posOrderStatusEnum = pgEnum('pos_order_status', ['open', 'cancelled']);

export const checks = pgTable(
  'checks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    restaurantId: text('restaurant_id').notNull(),
    total: numeric('total', { precision: 12, scale: 2 }).notNull(),
    status: checkStatusEnum('status').notNull().default('open'),
    createdAt: tz('created_at').notNull().defaultNow(),
    paidAt: tz('paid_at'),
    cancelledAt: tz('cancelled_at'),
    updatedAt: tz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    index('checks_restaurant_idx').on(t.restaurantId),
    check(
      'checks_status_timestamps',
      sql`(${t.status} <> 'cancelled' OR ${t.cancelledAt} IS NOT NULL) AND (${t.status} <> 'paid' OR ${t.paidAt} IS NOT NULL)`,
    ),
  ],
);

export const checkItems = pgTable(
  'check_items',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    checkId: uuid('check_id')
      .notNull()
      .references(() => checks.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    name: text('name').notNull(),
    quantity: integer('quantity').notNull(),
    unitPrice: numeric('unit_price', { precision: 12, scale: 2 }).notNull(),
  },
  (t) => [
    unique('check_items_check_position_uq').on(t.checkId, t.position),
    check('check_items_quantity_positive', sql`${t.quantity} > 0`),
  ],
);

/**
 * Transactional outbox row + per-check sync state machine. Inserted in the same transaction
 * that marks the check paid; cancel_requested is written in the same transaction that marks
 * the check cancelled. Exactly one row per check, so one lease serializes all POS calls for it.
 */
export const posSync = pgTable(
  'pos_sync',
  {
    checkId: uuid('check_id')
      .primaryKey()
      .references(() => checks.id, { onDelete: 'cascade' }),
    restaurantId: text('restaurant_id').notNull(),
    externalRef: text('external_ref').notNull(),
    state: syncStateEnum('state').notNull().default('pending'),
    cancelRequested: boolean('cancel_requested').notNull().default(false),

    posOrderId: text('pos_order_id'),
    posOrderStatus: posOrderStatusEnum('pos_order_status'),
    /** Duplicate open POS orders found during reconciliation; cancelled one by one. */
    extraOrderIds: text('extra_order_ids').array().notNull().default(sql`'{}'::text[]`),
    /** Set (and committed) before a create goes on the wire; cleared only when proven absent. */
    createSentAt: tz('create_sent_at'),

    attemptCount: integer('attempt_count').notNull().default(0),
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    manualRetryCount: integer('manual_retry_count').notNull().default(0),
    lastErrorKind: posErrorKindEnum('last_error_kind'),
    lastErrorMessage: text('last_error_message'),
    lastErrorStatus: integer('last_error_status'),
    lastErrorAt: tz('last_error_at'),
    lastAttemptAt: tz('last_attempt_at'),
    nextAttemptAt: tz('next_attempt_at').notNull().defaultNow(),

    leaseOwner: text('lease_owner'),
    leaseToken: uuid('lease_token'),
    leaseUntil: tz('lease_until'),

    syncedAt: tz('synced_at'),
    completedAt: tz('completed_at'),
    createdAt: tz('created_at').notNull().defaultNow(),
    updatedAt: tz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    unique('pos_sync_external_ref_uq').on(t.externalRef),
    index('pos_sync_due_idx')
      .on(t.nextAttemptAt)
      .where(sql`${t.state} IN ('pending', 'reconciling', 'cancelling')`),
    index('pos_sync_restaurant_idx').on(t.restaurantId),
    index('pos_sync_state_idx').on(t.state),
    check(
      'pos_sync_counters_non_negative',
      sql`${t.attemptCount} >= 0 AND ${t.consecutiveFailures} >= 0`,
    ),
  ],
);

/** Append-only history of every POS request made for a check (the admin timeline). */
export const posSyncAttempts = pgTable(
  'pos_sync_attempts',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    checkId: uuid('check_id')
      .notNull()
      .references(() => checks.id, { onDelete: 'cascade' }),
    operation: posOperationEnum('operation').notNull(),
    ok: boolean('ok').notNull(),
    errorKind: posErrorKindEnum('error_kind'),
    httpStatus: integer('http_status'),
    message: text('message'),
    posOrderId: text('pos_order_id'),
    instanceId: text('instance_id').notNull(),
    startedAt: tz('started_at').notNull(),
    finishedAt: tz('finished_at').notNull(),
  },
  (t) => [index('pos_sync_attempts_check_idx').on(t.checkId, t.startedAt)],
);

/** Sliding-window log of POS requests per restaurant, shared by all API instances. */
export const posRateEvents = pgTable(
  'pos_rate_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    restaurantId: text('restaurant_id').notNull(),
    sentAt: tz('sent_at').notNull().default(sql`clock_timestamp()`),
  },
  (t) => [index('pos_rate_events_restaurant_sent_idx').on(t.restaurantId, t.sentAt)],
);

/** A restaurant whose POS budget is exhausted (or that got a 429) is skipped until blocked_until. */
export const posRestaurantThrottle = pgTable('pos_restaurant_throttle', {
  restaurantId: text('restaurant_id').primaryKey(),
  blockedUntil: tz('blocked_until').notNull(),
  reason: text('reason').notNull(),
  updatedAt: tz('updated_at').notNull().defaultNow(),
});

export type CheckRow = typeof checks.$inferSelect;
export type CheckItemRow = typeof checkItems.$inferSelect;
export type PosSyncRow = typeof posSync.$inferSelect;
export type PosSyncAttemptRow = typeof posSyncAttempts.$inferSelect;
export type SyncState = (typeof syncStateEnum.enumValues)[number];
export type PosErrorKind = (typeof posErrorKindEnum.enumValues)[number];
export type PosOperation = (typeof posOperationEnum.enumValues)[number];

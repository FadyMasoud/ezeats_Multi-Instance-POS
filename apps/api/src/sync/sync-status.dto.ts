import type { CheckRow, PosErrorKind, PosSyncRow, SyncState } from '../db/schema';

/**
 * Operator-facing status. Derived from the stored state plus lease/failure counters, so it never
 * contradicts the backend model. For active rows, first match wins:
 *   processing          -> a worker currently holds the lease
 *   retrying            -> the last attempt failed (any active state); waiting for backoff
 *   pending             -> state=pending
 *   reconciling         -> state=reconciling (looking up a possibly-created order)
 *   cancellation_pending-> state=cancelling
 * Otherwise: synced, cancelled, failed mirror the state; awaiting_payment / not_required mean
 * there is no sync row (check open, or cancelled before payment).
 */
export type SyncDisplayStatus =
  | 'awaiting_payment'
  | 'not_required'
  | 'processing'
  | 'pending'
  | 'retrying'
  | 'reconciling'
  | 'cancellation_pending'
  | 'synced'
  | 'cancelled'
  | 'failed';

/** List filter: a display status, or `in_progress` = processing + pending + reconciling + cancellation_pending. */
export type SyncStatusFilter = SyncDisplayStatus | 'in_progress';

export interface SyncErrorDto {
  kind: PosErrorKind;
  message: string | null;
  httpStatus: number | null;
  at: string | null;
}

export interface SyncStatusDto {
  checkId: string;
  restaurantId: string;
  checkStatus: CheckRow['status'];
  /** Stored state; null when the check was never paid. */
  state: SyncState | null;
  displayStatus: SyncDisplayStatus;
  externalRef: string | null;
  posOrderId: string | null;
  posOrderStatus: 'open' | 'cancelled' | null;
  cancelRequested: boolean;
  /** Total POS requests made for this check. */
  attempts: number;
  consecutiveFailures: number;
  manualRetries: number;
  lastError: SyncErrorDto | null;
  lastAttemptAt: string | null;
  /** Only set while the sync is still active. */
  nextAttemptAt: string | null;
  processing: { owner: string | null; leaseUntil: string | null } | null;
  createSentAt: string | null;
  syncedAt: string | null;
  completedAt: string | null;
  retryable: boolean;
  retryBlockedReason: string | null;
  updatedAt: string | null;
}

const ACTIVE: ReadonlySet<SyncState> = new Set(['pending', 'reconciling', 'cancelling']);

const iso = (d: Date | null | undefined) => d?.toISOString() ?? null;

export function displayStatusOf(row: PosSyncRow, now: Date): SyncDisplayStatus {
  const leased = row.leaseUntil !== null && row.leaseUntil > now;
  if (ACTIVE.has(row.state) && leased) return 'processing';
  if (ACTIVE.has(row.state) && row.consecutiveFailures > 0) return 'retrying';
  switch (row.state) {
    case 'cancelling':
      return 'cancellation_pending';
    default:
      return row.state;
  }
}

export function retryBlockedReason(row: PosSyncRow | null): string | null {
  if (!row) return 'check has not been paid, nothing to sync';
  switch (row.state) {
    case 'failed':
      return null;
    case 'synced':
      return 'already synced to the POS';
    case 'cancelled':
      return 'sync is complete: the POS has no open order for this cancelled check';
    default:
      return 'sync is still active and will retry automatically';
  }
}

export function toSyncStatus(check: CheckRow, row: PosSyncRow | null, now: Date): SyncStatusDto {
  const blocked = retryBlockedReason(row);
  if (!row) {
    return {
      checkId: check.id,
      restaurantId: check.restaurantId,
      checkStatus: check.status,
      state: null,
      displayStatus: check.status === 'open' ? 'awaiting_payment' : 'not_required',
      externalRef: null,
      posOrderId: null,
      posOrderStatus: null,
      cancelRequested: check.status === 'cancelled',
      attempts: 0,
      consecutiveFailures: 0,
      manualRetries: 0,
      lastError: null,
      lastAttemptAt: null,
      nextAttemptAt: null,
      processing: null,
      createSentAt: null,
      syncedAt: null,
      completedAt: null,
      retryable: false,
      retryBlockedReason: blocked,
      updatedAt: null,
    };
  }
  const leased = row.leaseUntil !== null && row.leaseUntil > now;
  return {
    checkId: check.id,
    restaurantId: row.restaurantId,
    checkStatus: check.status,
    state: row.state,
    displayStatus: displayStatusOf(row, now),
    externalRef: row.externalRef,
    posOrderId: row.posOrderId,
    posOrderStatus: row.posOrderStatus,
    cancelRequested: row.cancelRequested,
    attempts: row.attemptCount,
    consecutiveFailures: row.consecutiveFailures,
    manualRetries: row.manualRetryCount,
    lastError: row.lastErrorKind
      ? {
          kind: row.lastErrorKind,
          message: row.lastErrorMessage,
          httpStatus: row.lastErrorStatus,
          at: iso(row.lastErrorAt),
        }
      : null,
    lastAttemptAt: iso(row.lastAttemptAt),
    nextAttemptAt: ACTIVE.has(row.state) ? iso(row.nextAttemptAt) : null,
    processing: leased ? { owner: row.leaseOwner, leaseUntil: iso(row.leaseUntil) } : null,
    createSentAt: iso(row.createSentAt),
    syncedAt: iso(row.syncedAt),
    completedAt: iso(row.completedAt),
    retryable: blocked === null,
    retryBlockedReason: blocked,
    updatedAt: iso(row.updatedAt),
  };
}

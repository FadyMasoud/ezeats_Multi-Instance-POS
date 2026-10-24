// Mirrors apps/api/src/sync/sync-status.dto.ts and the admin endpoints.

export type SyncState =
  | 'pending'
  | 'reconciling'
  | 'cancelling'
  | 'synced'
  | 'cancelled'
  | 'failed';

export type DisplayStatus =
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

export type ErrorKind =
  | 'server_error'
  | 'rate_limited'
  | 'rejected'
  | 'timeout'
  | 'network'
  | 'unexpected'
  | 'retries_exhausted';

export interface SyncStatus {
  checkId: string;
  restaurantId: string;
  checkStatus: 'open' | 'paid' | 'cancelled';
  state: SyncState | null;
  displayStatus: DisplayStatus;
  externalRef: string | null;
  posOrderId: string | null;
  posOrderStatus: 'open' | 'cancelled' | null;
  cancelRequested: boolean;
  attempts: number;
  consecutiveFailures: number;
  manualRetries: number;
  lastError: {
    kind: ErrorKind;
    message: string | null;
    httpStatus: number | null;
    at: string | null;
  } | null;
  lastAttemptAt: string | null;
  nextAttemptAt: string | null;
  processing: { owner: string | null; leaseUntil: string | null } | null;
  createSentAt: string | null;
  syncedAt: string | null;
  completedAt: string | null;
  retryable: boolean;
  retryBlockedReason: string | null;
  updatedAt: string | null;
}

export interface SyncListItem extends SyncStatus {
  total: number;
  checkCreatedAt: string;
}

export interface SyncList {
  items: SyncListItem[];
  total: number;
  page: number;
  pageSize: number;
}

export interface SyncSummary {
  totalChecks: number;
  paidChecks: number;
  cancelledChecks: number;
  synced: number;
  pending: number;
  retrying: number;
  reconciling: number;
  cancellationPending: number;
  failed: number;
  posCancelled: number;
  restaurants: string[];
}

export interface Check {
  id: string;
  restaurantId: string;
  status: 'open' | 'paid' | 'cancelled';
  total: number;
  items: { name: string; quantity: number; unitPrice: number }[];
  createdAt: string;
  paidAt: string | null;
  cancelledAt: string | null;
}

export interface SyncAttempt {
  id: number;
  operation: 'create' | 'lookup' | 'cancel';
  ok: boolean;
  errorKind: ErrorKind | null;
  httpStatus: number | null;
  message: string | null;
  posOrderId: string | null;
  instanceId: string;
  startedAt: string;
  durationMs: number;
}

export interface CheckDetails {
  check: Check;
  sync: SyncStatus;
  attempts: SyncAttempt[];
}

/** A display status, or the `in_progress` group (processing + pending + reconciling + cancelling). */
export type StatusFilter = DisplayStatus | 'in_progress';

export interface ListFilters {
  status: StatusFilter | '';
  restaurantId: string;
  errorKind: ErrorKind | '';
  q: string;
  page: number;
}

import type { DisplayStatus, ErrorKind } from './types';

export const STATUS_LABELS: Record<DisplayStatus, string> = {
  awaiting_payment: 'Awaiting payment',
  not_required: 'Not required',
  processing: 'Processing',
  pending: 'Pending',
  retrying: 'Retrying',
  reconciling: 'Reconciling',
  cancellation_pending: 'Cancellation pending',
  synced: 'Synced',
  cancelled: 'Cancelled',
  failed: 'Failed',
};

export const STATUS_HELP: Record<DisplayStatus, string> = {
  awaiting_payment: 'Check is open; nothing is sent to the POS until it is paid.',
  not_required: 'Cancelled before payment; the POS was never involved.',
  processing: 'An API instance is talking to the POS for this check right now.',
  pending: 'Queued: the POS order will be created shortly.',
  retrying: 'The last POS call failed; it will be retried automatically.',
  reconciling:
    'A create may already have reached the POS; looking it up by externalRef before acting.',
  cancellation_pending: 'The check was cancelled; the POS order is being cancelled.',
  synced: 'Exactly one open POS order exists for this check.',
  cancelled: 'The POS has no open order for this check.',
  failed: 'Automatic retries stopped. Review the error and retry manually.',
};

export const ERROR_KIND_LABELS: Record<ErrorKind, string> = {
  server_error: 'POS server error',
  rate_limited: 'Rate limited (429)',
  rejected: 'Rejected by POS',
  timeout: 'Timeout',
  network: 'Network error',
  unexpected: 'Unexpected response',
  retries_exhausted: 'Retries exhausted',
};

const money = new Intl.NumberFormat('en-EG', { style: 'currency', currency: 'EGP' });
export const formatMoney = (value: number) => money.format(value);

const dateTime = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'medium',
});
export const formatDateTime = (iso: string | null) => (iso ? dateTime.format(new Date(iso)) : '—');

export function relativeTime(iso: string | null, now = Date.now()): string {
  if (!iso) return '—';
  const diff = new Date(iso).getTime() - now;
  const abs = Math.abs(diff);
  const unit =
    abs < 1_000
      ? 'now'
      : abs < 60_000
        ? `${Math.round(abs / 1_000)}s`
        : abs < 3_600_000
          ? `${Math.round(abs / 60_000)}m`
          : abs < 86_400_000
            ? `${Math.round(abs / 3_600_000)}h`
            : `${Math.round(abs / 86_400_000)}d`;
  if (unit === 'now') return 'just now';
  return diff < 0 ? `${unit} ago` : `in ${unit}`;
}

export const shortId = (id: string) => id.slice(0, 8);

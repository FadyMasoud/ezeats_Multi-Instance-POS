import { useCallback, useEffect, useRef, useState } from 'react';
import { type ApiClient, ApiError } from '../api';
import {
  ERROR_KIND_LABELS,
  STATUS_HELP,
  formatDateTime,
  formatMoney,
  relativeTime,
} from '../format';
import type { CheckDetails, SyncStatus } from '../types';
import { StatusBadge } from './StatusBadge';

interface Props {
  client: ApiClient;
  checkId: string;
  refreshKey: number;
  retrying: boolean;
  onClose: () => void;
  onRetry: (sync: SyncStatus) => void;
  onUnauthorized: () => void;
}

const POLL_MS = 3_000;

export function DetailsDrawer({
  client,
  checkId,
  refreshKey,
  retrying,
  onClose,
  onRetry,
  onUnauthorized,
}: Props) {
  const [details, setDetails] = useState<CheckDetails | null>(null);
  const [error, setError] = useState<string | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  const load = useCallback(async () => {
    try {
      setDetails(await client.details(checkId));
      setError(null);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return onUnauthorized();
      setError(e instanceof Error ? e.message : 'Failed to load the check');
    }
  }, [client, checkId, onUnauthorized]);

  // The parent remounts the drawer per check (key={checkId}), so this runs once per check.
  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey is a trigger; the parent bumps it after a retry to reload immediately.
  useEffect(() => {
    void load();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [load, refreshKey]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const sync = details?.sync;
  const check = details?.check;

  return (
    <aside className="drawer" aria-labelledby="drawer-title" aria-busy={!details}>
      <header className="drawer__header">
        <div>
          <p className="eyebrow">Check details</p>
          <h2 id="drawer-title" className="mono">
            {checkId}
          </h2>
        </div>
        <button
          ref={closeRef}
          type="button"
          className="btn btn--ghost btn--icon"
          onClick={onClose}
          aria-label="Close details"
        >
          ✕
        </button>
      </header>

      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {!details && !error && <div className="skeleton" aria-label="Loading" />}

      {sync && check && (
        <div className="drawer__body">
          <section className="panel">
            <div className="panel__row">
              <StatusBadge status={sync.displayStatus} />
              <span className="muted small">updated {relativeTime(sync.updatedAt)}</span>
            </div>
            <p className="small">{STATUS_HELP[sync.displayStatus]}</p>
            {sync.retryable ? (
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => onRetry(sync)}
                disabled={retrying}
              >
                {retrying ? 'Queuing retry…' : 'Retry Sync'}
              </button>
            ) : (
              <p className="eligibility">
                <strong>Manual retry not available:</strong> {sync.retryBlockedReason}
              </p>
            )}
          </section>

          {sync.lastError && (
            <section
              className={`panel panel--error${sync.state === 'failed' ? '' : ' panel--soft'}`}
            >
              <h3>Last error</h3>
              <p>
                <strong>{ERROR_KIND_LABELS[sync.lastError.kind]}</strong>
                {sync.lastError.httpStatus ? ` · HTTP ${sync.lastError.httpStatus}` : ''}
                <span className="muted small"> · {formatDateTime(sync.lastError.at)}</span>
              </p>
              <p className="mono small wrap">{sync.lastError.message}</p>
              {sync.state !== 'failed' && (
                <p className="muted small">Recorded earlier; the sync has continued since.</p>
              )}
            </section>
          )}

          <section className="panel">
            <h3>POS synchronization</h3>
            <dl className="kv">
              <dt>State</dt>
              <dd className="mono">{sync.state ?? 'not started'}</dd>
              <dt>External ref</dt>
              <dd className="mono">{sync.externalRef ?? '—'}</dd>
              <dt>POS order</dt>
              <dd className="mono">
                {sync.posOrderId ?? '—'}
                {sync.posOrderStatus ? ` (${sync.posOrderStatus})` : ''}
              </dd>
              <dt>Attempts</dt>
              <dd>
                {sync.attempts} total · {sync.consecutiveFailures} consecutive failures ·{' '}
                {sync.manualRetries} manual
              </dd>
              <dt>Last attempt</dt>
              <dd>{formatDateTime(sync.lastAttemptAt)}</dd>
              <dt>Next attempt</dt>
              <dd>
                {sync.nextAttemptAt
                  ? `${formatDateTime(sync.nextAttemptAt)} (${relativeTime(sync.nextAttemptAt)})`
                  : '—'}
              </dd>
              <dt>Processing</dt>
              <dd>
                {sync.processing
                  ? `${sync.processing.owner} until ${formatDateTime(sync.processing.leaseUntil)}`
                  : '—'}
              </dd>
              <dt>Create sent</dt>
              <dd>{formatDateTime(sync.createSentAt)}</dd>
              <dt>Synced at</dt>
              <dd>{formatDateTime(sync.syncedAt)}</dd>
              <dt>Cancel requested</dt>
              <dd>{sync.cancelRequested ? 'Yes' : 'No'}</dd>
            </dl>
          </section>

          <section className="panel">
            <h3>Check</h3>
            <dl className="kv">
              <dt>Restaurant</dt>
              <dd className="mono">{check.restaurantId}</dd>
              <dt>Status</dt>
              <dd className="cap">{check.status}</dd>
              <dt>Created</dt>
              <dd>{formatDateTime(check.createdAt)}</dd>
              <dt>Paid</dt>
              <dd>{formatDateTime(check.paidAt)}</dd>
              <dt>Cancelled</dt>
              <dd>{formatDateTime(check.cancelledAt)}</dd>
            </dl>
            <table className="table table--compact">
              <thead>
                <tr>
                  <th scope="col">Item</th>
                  <th scope="col" className="num">
                    Qty
                  </th>
                  <th scope="col" className="num">
                    Unit price
                  </th>
                </tr>
              </thead>
              <tbody>
                {check.items.map((item, i) => (
                  <tr key={`${item.name}-${i}`}>
                    <td>{item.name}</td>
                    <td className="num">{item.quantity}</td>
                    <td className="num">{formatMoney(item.unitPrice)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th scope="row" colSpan={2}>
                    Total
                  </th>
                  <td className="num strong">{formatMoney(check.total)}</td>
                </tr>
              </tfoot>
            </table>
          </section>

          <section className="panel">
            <h3>POS request history</h3>
            {details.attempts.length === 0 ? (
              <p className="muted small">No POS requests have been made for this check.</p>
            ) : (
              <ol className="timeline">
                {details.attempts.map((a) => (
                  <li key={a.id} className={a.ok ? 'ok' : 'fail'}>
                    <div className="timeline__head">
                      <span className="op">{a.operation}</span>
                      <span className={a.ok ? 'pill pill--ok' : 'pill pill--fail'}>
                        {a.ok ? 'OK' : a.errorKind ? ERROR_KIND_LABELS[a.errorKind] : 'failed'}
                        {a.httpStatus ? ` · ${a.httpStatus}` : ''}
                      </span>
                      <span className="muted small">{formatDateTime(a.startedAt)}</span>
                    </div>
                    <div className="small">{a.message}</div>
                    <div className="muted small">
                      {a.instanceId} · {a.durationMs} ms
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>
      )}
    </aside>
  );
}

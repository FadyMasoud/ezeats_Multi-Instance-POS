import { useEffect, useRef } from 'react';
import { ERROR_KIND_LABELS } from '../format';
import type { SyncStatus } from '../types';

interface Props {
  target: SyncStatus;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function RetryDialog({ target, busy, onConfirm, onCancel }: Props) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onCancel]);

  const error = target.lastError;
  const mayExist = target.createSentAt !== null && target.posOrderId === null;

  return (
    // A confirmation for an operator action: it closes only via Cancel or Escape, never by a
    // stray click on the backdrop.
    <div className="overlay">
      <div
        className="dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="retry-title"
        aria-describedby="retry-desc"
      >
        <h2 id="retry-title">Retry POS sync?</h2>
        <dl className="kv kv--compact">
          <dt>Check</dt>
          <dd className="mono">{target.checkId}</dd>
          <dt>Restaurant</dt>
          <dd className="mono">{target.restaurantId}</dd>
          <dt>Failure</dt>
          <dd>
            {error ? (
              <>
                <strong>{ERROR_KIND_LABELS[error.kind]}</strong>
                {error.httpStatus ? ` (HTTP ${error.httpStatus})` : ''}
                <div className="sub">{error.message}</div>
              </>
            ) : (
              'No error recorded'
            )}
          </dd>
        </dl>
        <div id="retry-desc" className="callout">
          <p>
            The sync will be re-queued and an API worker will resume it safely. This never sends a
            duplicate order:{' '}
            {mayExist
              ? 'a create may already have reached the POS, so it will first look the order up by its externalRef'
              : 'if a create may already have reached the POS, the worker looks it up by externalRef before creating anything'}
            .
          </p>
          {error?.kind === 'rejected' && (
            <p>
              The POS rejected this check permanently. Unless the cause has been fixed on the POS
              side, the retry will fail again with the same reason.
            </p>
          )}
        </div>
        <div className="dialog__actions">
          <button
            ref={cancelRef}
            type="button"
            className="btn btn--ghost"
            onClick={onCancel}
            disabled={busy}
          >
            Cancel
          </button>
          <button type="button" className="btn btn--primary" onClick={onConfirm} disabled={busy}>
            {busy ? 'Queuing retry…' : 'Retry Sync'}
          </button>
        </div>
      </div>
    </div>
  );
}

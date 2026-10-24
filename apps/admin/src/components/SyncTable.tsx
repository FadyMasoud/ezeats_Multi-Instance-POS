import { ERROR_KIND_LABELS, formatDateTime, formatMoney, relativeTime, shortId } from '../format';
import type { SyncListItem } from '../types';
import { StatusBadge } from './StatusBadge';

interface Props {
  items: SyncListItem[];
  loading: boolean;
  selectedId: string | null;
  retryingId: string | null;
  onOpen: (id: string) => void;
  onRetry: (item: SyncListItem) => void;
}

const CHECK_STATUS: Record<SyncListItem['checkStatus'], string> = {
  open: 'Open',
  paid: 'Paid',
  cancelled: 'Cancelled',
};

export function SyncTable({ items, loading, selectedId, retryingId, onOpen, onRetry }: Props) {
  if (!loading && items.length === 0) {
    return (
      <div className="empty">
        <p className="empty__title">No checks match these filters</p>
        <p className="muted">Try clearing a filter, or create and pay a check through the API.</p>
      </div>
    );
  }

  return (
    <div className="table-wrap" aria-busy={loading}>
      <table className="table">
        <thead>
          <tr>
            <th scope="col">Check</th>
            <th scope="col">Restaurant</th>
            <th scope="col">Check status</th>
            <th scope="col">POS sync</th>
            <th scope="col">POS order</th>
            <th scope="col" className="num">
              Attempts
            </th>
            <th scope="col">Last error</th>
            <th scope="col">Last attempt</th>
            <th scope="col">Next retry</th>
            <th scope="col">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            // biome-ignore lint/a11y/useKeyWithClickEvents: row click is a mouse shortcut; the check-ID button in the first cell is the keyboard control.
            <tr
              key={item.checkId}
              className={item.checkId === selectedId ? 'is-selected' : undefined}
              onClick={() => onOpen(item.checkId)}
            >
              <td>
                <button
                  type="button"
                  className="link mono"
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpen(item.checkId);
                  }}
                  title={item.checkId}
                  aria-label={`Open details for check ${item.checkId}`}
                >
                  {shortId(item.checkId)}
                </button>
                <div className="sub">{formatMoney(item.total)}</div>
              </td>
              <td className="mono">{item.restaurantId}</td>
              <td>{CHECK_STATUS[item.checkStatus]}</td>
              <td>
                <StatusBadge status={item.displayStatus} />
              </td>
              <td className="mono">
                {item.posOrderId ?? <span className="muted">—</span>}
                {item.posOrderStatus === 'cancelled' && <div className="sub">cancelled on POS</div>}
              </td>
              <td className="num">{item.attempts}</td>
              <td className="error-cell">
                {item.lastError ? (
                  <span title={item.lastError.message ?? undefined}>
                    <strong>{ERROR_KIND_LABELS[item.lastError.kind]}</strong>
                    {item.lastError.httpStatus ? ` · ${item.lastError.httpStatus}` : ''}
                    <span className="sub clamp">{item.lastError.message}</span>
                  </span>
                ) : (
                  <span className="muted">—</span>
                )}
              </td>
              <td title={formatDateTime(item.lastAttemptAt)}>{relativeTime(item.lastAttemptAt)}</td>
              <td title={formatDateTime(item.nextAttemptAt)}>{relativeTime(item.nextAttemptAt)}</td>
              <td className="actions">
                {item.retryable && (
                  <button
                    type="button"
                    className="btn btn--danger-soft btn--sm"
                    disabled={retryingId === item.checkId}
                    onClick={(e) => {
                      e.stopPropagation();
                      onRetry(item);
                    }}
                    aria-label={`Retry sync for check ${item.checkId}`}
                  >
                    {retryingId === item.checkId ? 'Retrying…' : 'Retry Sync'}
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

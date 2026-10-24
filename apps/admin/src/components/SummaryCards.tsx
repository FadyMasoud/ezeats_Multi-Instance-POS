import type { StatusFilter, SyncSummary } from '../types';

interface Props {
  summary: SyncSummary | null;
  activeStatus: StatusFilter | '';
  onSelect: (status: StatusFilter | '') => void;
}

interface Card {
  key: string;
  label: string;
  value: (s: SyncSummary) => number;
  detail: (s: SyncSummary) => string;
  tone: string;
  /** The table filter whose row count equals this card's value. */
  filter: StatusFilter | '';
}

const CARDS: Card[] = [
  {
    key: 'total',
    label: 'Total checks',
    value: (s) => s.totalChecks,
    detail: (s) => `${s.paidChecks} paid`,
    tone: 'neutral',
    filter: '',
  },
  {
    key: 'synced',
    label: 'Synced orders',
    value: (s) => s.synced,
    detail: () => 'open on the POS',
    tone: 'success',
    filter: 'synced',
  },
  {
    key: 'pending',
    label: 'Pending sync',
    value: (s) => s.pending,
    detail: (s) => `${s.reconciling} reconciling · ${s.cancellationPending} cancelling`,
    tone: 'info',
    filter: 'in_progress',
  },
  {
    key: 'retrying',
    label: 'Retrying',
    value: (s) => s.retrying,
    detail: () => 'waiting for backoff',
    tone: 'warning',
    filter: 'retrying',
  },
  {
    key: 'failed',
    label: 'Failed sync',
    value: (s) => s.failed,
    detail: () => 'needs an operator',
    tone: 'danger',
    filter: 'failed',
  },
  {
    key: 'cancelled',
    label: 'Cancelled checks',
    value: (s) => s.cancelledChecks,
    detail: (s) => `${s.posCancelled} closed on the POS`,
    tone: 'muted',
    filter: '',
  },
];

export function SummaryCards({ summary, activeStatus, onSelect }: Props) {
  return (
    <section className="cards" aria-label="Synchronization summary">
      {CARDS.map((card) => {
        const active = card.filter !== '' && card.filter === activeStatus;
        const value = summary ? card.value(summary).toLocaleString() : '–';
        const content = (
          <>
            <span className="card__label">{card.label}</span>
            <span className="card__value">{value}</span>
            <span className="card__detail">{summary ? card.detail(summary) : ' '}</span>
          </>
        );
        if (!card.filter) {
          return (
            <div key={card.key} className={`card card--${card.tone} card--static`}>
              {content}
            </div>
          );
        }
        return (
          <button
            key={card.key}
            type="button"
            className={`card card--${card.tone}${active ? ' card--active' : ''}`}
            onClick={() => onSelect(active ? '' : card.filter)}
            aria-pressed={active}
            title={active ? 'Clear filter' : `Show only: ${card.label.toLowerCase()}`}
          >
            {content}
          </button>
        );
      })}
    </section>
  );
}

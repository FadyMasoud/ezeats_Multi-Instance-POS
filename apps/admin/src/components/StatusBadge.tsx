import { STATUS_HELP, STATUS_LABELS } from '../format';
import type { DisplayStatus } from '../types';

export function StatusBadge({ status }: { status: DisplayStatus }) {
  return (
    <span className={`badge badge--${status}`} title={STATUS_HELP[status]}>
      <span className="badge__dot" aria-hidden="true" />
      {STATUS_LABELS[status]}
    </span>
  );
}

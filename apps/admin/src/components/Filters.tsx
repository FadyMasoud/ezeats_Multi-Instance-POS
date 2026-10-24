import { useEffect, useState } from 'react';
import { ERROR_KIND_LABELS, STATUS_LABELS } from '../format';
import type { DisplayStatus, ErrorKind, ListFilters, StatusFilter } from '../types';

interface Props {
  filters: ListFilters;
  restaurants: string[];
  onChange: (patch: Partial<ListFilters>) => void;
}

const STATUSES = Object.keys(STATUS_LABELS) as DisplayStatus[];
const ERROR_KINDS = Object.keys(ERROR_KIND_LABELS) as ErrorKind[];

export function Filters({ filters, restaurants, onChange }: Props) {
  const [search, setSearch] = useState(filters.q);

  // Debounce the free-text search so typing does not fire a request per keystroke.
  useEffect(() => {
    if (search === filters.q) return;
    const t = setTimeout(() => onChange({ q: search, page: 1 }), 300);
    return () => clearTimeout(t);
  }, [search, filters.q, onChange]);

  useEffect(() => setSearch(filters.q), [filters.q]);

  const hasFilters = Boolean(
    filters.status || filters.restaurantId || filters.errorKind || filters.q,
  );

  return (
    <form className="filters" aria-label="Filter sync records" onSubmit={(e) => e.preventDefault()}>
      <label className="field field--grow">
        <span>Search</span>
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Check ID (prefix)"
          aria-label="Search by check ID prefix"
        />
      </label>
      <label className="field">
        <span>Sync status</span>
        <select
          value={filters.status}
          onChange={(e) => onChange({ status: e.target.value as StatusFilter | '', page: 1 })}
        >
          <option value="">All statuses</option>
          <option value="in_progress">In progress (all active)</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABELS[s]}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>Restaurant</span>
        <select
          value={filters.restaurantId}
          onChange={(e) => onChange({ restaurantId: e.target.value, page: 1 })}
        >
          <option value="">All restaurants</option>
          {restaurants.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>Last error</span>
        <select
          value={filters.errorKind}
          onChange={(e) => onChange({ errorKind: e.target.value as ErrorKind | '', page: 1 })}
        >
          <option value="">Any</option>
          {ERROR_KINDS.map((k) => (
            <option key={k} value={k}>
              {ERROR_KIND_LABELS[k]}
            </option>
          ))}
        </select>
      </label>
      <button
        type="button"
        className="btn btn--ghost filters__clear"
        disabled={!hasFilters}
        onClick={() => {
          setSearch('');
          onChange({ status: '', restaurantId: '', errorKind: '', q: '', page: 1 });
        }}
      >
        Clear
      </button>
    </form>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, PAGE_SIZE, createClient } from './api';
import { DetailsDrawer } from './components/DetailsDrawer';
import { Filters } from './components/Filters';
import { RetryDialog } from './components/RetryDialog';
import { SummaryCards } from './components/SummaryCards';
import { SyncTable } from './components/SyncTable';
import { TokenGate } from './components/TokenGate';
import { STATUS_LABELS } from './format';
import type { ListFilters, SyncList, SyncStatus, SyncSummary } from './types';

const TOKEN_KEY = 'ezeats.adminToken';
const POLL_MS = 5_000;

function readToken(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function writeToken(token: string | null) {
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    // Storage can be unavailable (private mode); the session then lasts until reload.
  }
}

interface Toast {
  id: number;
  tone: 'success' | 'error';
  title: string;
  message: string;
}

export function App() {
  const [token, setToken] = useState<string | null>(readToken);
  const [gateNotice, setGateNotice] = useState<string | null>(null);

  const signOut = useCallback((notice: string | null = null) => {
    writeToken(null);
    setToken(null);
    setGateNotice(notice);
  }, []);

  if (!token) {
    return (
      <TokenGate
        notice={gateNotice}
        onAuthenticated={(t) => {
          writeToken(t);
          setToken(t);
        }}
      />
    );
  }
  return <Dashboard token={token} onSignOut={signOut} />;
}

function Dashboard({
  token,
  onSignOut,
}: { token: string; onSignOut: (notice?: string | null) => void }) {
  const client = useMemo(() => createClient(token), [token]);
  const [filters, setFilters] = useState<ListFilters>({
    status: '',
    restaurantId: '',
    errorKind: '',
    q: '',
    page: 1,
  });
  const [summary, setSummary] = useState<SyncSummary | null>(null);
  const [list, setList] = useState<SyncList | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [retryTarget, setRetryTarget] = useState<SyncStatus | null>(null);
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [drawerRefresh, setDrawerRefresh] = useState(0);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const requestSeq = useRef(0);

  const onUnauthorized = useCallback(
    () => onSignOut('Your operator token was rejected. Please sign in again.'),
    [onSignOut],
  );

  const pushToast = useCallback((toast: Omit<Toast, 'id'>) => {
    const id = Date.now() + Math.random();
    setToasts((all) => [...all, { ...toast, id }]);
    setTimeout(() => setToasts((all) => all.filter((t) => t.id !== id)), 7_000);
  }, []);

  const refresh = useCallback(async () => {
    const seq = ++requestSeq.current;
    try {
      const [s, l] = await Promise.all([client.summary(), client.list(filters)]);
      if (seq !== requestSeq.current) return; // a newer request superseded this one
      setSummary(s);
      setList(l);
      setLoadError(null);
      setLastRefresh(new Date());
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return onUnauthorized();
      if (seq === requestSeq.current)
        setLoadError(e instanceof Error ? e.message : 'Failed to load data');
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [client, filters, onUnauthorized]);

  useEffect(() => {
    setLoading(true);
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!autoRefresh) return;
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [autoRefresh, refresh]);

  const updateFilters = useCallback(
    (patch: Partial<ListFilters>) => setFilters((f) => ({ ...f, ...patch })),
    [],
  );

  async function confirmRetry() {
    if (!retryTarget || retryingId) return;
    const checkId = retryTarget.checkId;
    setRetryingId(checkId);
    try {
      const status = await client.retry(checkId);
      pushToast({
        tone: 'success',
        title: 'Retry queued',
        message: `Check ${checkId.slice(0, 8)} is now "${STATUS_LABELS[status.displayStatus]}". Progress updates automatically.`,
      });
      setRetryTarget(null);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return onUnauthorized();
      pushToast({
        tone: 'error',
        title: e instanceof ApiError && e.status === 409 ? 'Retry not allowed' : 'Retry failed',
        message: e instanceof Error ? e.message : 'Unknown error',
      });
      setRetryTarget(null);
    } finally {
      setRetryingId(null);
      setDrawerRefresh((n) => n + 1);
      void refresh();
    }
  }

  const total = list?.total ?? 0;
  const from = total === 0 ? 0 : (filters.page - 1) * PAGE_SIZE + 1;
  const to = Math.min(filters.page * PAGE_SIZE, total);
  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className={`layout${selectedId ? ' layout--drawer' : ''}`}>
      <header className="topbar">
        <div className="brand">
          <span className="brand__mark" aria-hidden="true" />
          <span>EZeats Operations</span>
        </div>
        <div className="topbar__right">
          <span className="muted small" aria-live="polite">
            {lastRefresh ? `Updated ${lastRefresh.toLocaleTimeString()}` : 'Loading…'}
          </span>
          <label className="toggle">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
            />
            <span>Auto-refresh</span>
          </label>
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => void refresh()}>
            Refresh
          </button>
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => onSignOut()}>
            Sign out
          </button>
        </div>
      </header>

      <main className="content">
        <div className="page-head">
          <div>
            <h1>POS Sync Operations</h1>
            <p className="muted">
              Every paid check must reach its restaurant's POS exactly once. Monitor progress,
              inspect failures and retry stopped syncs.
            </p>
          </div>
        </div>

        <SummaryCards
          summary={summary}
          activeStatus={filters.status}
          onSelect={(status) => updateFilters({ status, page: 1 })}
        />

        <section className="surface" aria-labelledby="records-title">
          <div className="surface__head">
            <h2 id="records-title">Sync records</h2>
            <Filters
              filters={filters}
              restaurants={summary?.restaurants ?? []}
              onChange={updateFilters}
            />
          </div>

          {loadError && (
            <div className="banner banner--error" role="alert">
              <span>{loadError}</span>
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => void refresh()}
              >
                Try again
              </button>
            </div>
          )}

          {loading && !list ? (
            <div className="skeleton skeleton--table" aria-label="Loading sync records" />
          ) : (
            <SyncTable
              items={list?.items ?? []}
              loading={loading}
              selectedId={selectedId}
              retryingId={retryingId}
              onOpen={setSelectedId}
              onRetry={setRetryTarget}
            />
          )}

          <nav className="pager" aria-label="Pagination">
            <span className="muted small">
              {total > 0 ? `Showing ${from}–${to} of ${total.toLocaleString()}` : 'No records'}
            </span>
            <div className="pager__buttons">
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                disabled={filters.page <= 1}
                onClick={() => updateFilters({ page: filters.page - 1 })}
              >
                ← Previous
              </button>
              <span className="small">
                Page {filters.page} of {lastPage}
              </span>
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                disabled={filters.page >= lastPage}
                onClick={() => updateFilters({ page: filters.page + 1 })}
              >
                Next →
              </button>
            </div>
          </nav>
        </section>
      </main>

      {selectedId && (
        <DetailsDrawer
          key={selectedId}
          client={client}
          checkId={selectedId}
          refreshKey={drawerRefresh}
          retrying={retryingId === selectedId}
          onClose={() => setSelectedId(null)}
          onRetry={setRetryTarget}
          onUnauthorized={onUnauthorized}
        />
      )}

      {retryTarget && (
        <RetryDialog
          target={retryTarget}
          busy={retryingId === retryTarget.checkId}
          onConfirm={() => void confirmRetry()}
          onCancel={() => setRetryTarget(null)}
        />
      )}

      <div className="toasts" aria-live="assertive">
        {toasts.map((t) => (
          <output key={t.id} className={`toast toast--${t.tone}`}>
            <strong>{t.title}</strong>
            <span>{t.message}</span>
          </output>
        ))}
      </div>
    </div>
  );
}

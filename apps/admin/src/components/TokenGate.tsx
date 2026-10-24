import { type FormEvent, useState } from 'react';
import { ApiError, createClient } from '../api';

interface Props {
  onAuthenticated: (token: string) => void;
  notice: string | null;
}

/** Asks for the operator token and validates it against the backend before continuing. */
export function TokenGate({ onAuthenticated, notice }: Props) {
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(notice);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!token.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await createClient(token.trim()).session();
      onAuthenticated(token.trim());
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not verify the token.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="gate">
      <form className="gate__card" onSubmit={submit} aria-labelledby="gate-title">
        <div className="brand brand--large">
          <span className="brand__mark" aria-hidden="true" />
          <span>EZeats Operations</span>
        </div>
        <h1 id="gate-title">POS Sync Operations</h1>
        <p className="muted">
          Enter the operator token to monitor POS synchronization and retry stopped syncs.
        </p>
        <label className="field">
          <span>Operator token</span>
          <input
            type="password"
            autoComplete="current-password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="ADMIN_TOKEN"
            required
          />
        </label>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <button
          className="btn btn--primary btn--block"
          type="submit"
          disabled={busy || !token.trim()}
        >
          {busy ? 'Checking…' : 'Continue'}
        </button>
        <p className="hint">
          Local development uses <code>ADMIN_TOKEN</code> from the environment. This is not
          production authentication.
        </p>
      </form>
    </main>
  );
}

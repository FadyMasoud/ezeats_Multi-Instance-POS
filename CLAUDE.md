# EZeats POS sync

Sends paid checks to each restaurant's third-party POS exactly once, and cancels them there when a
check is cancelled. NestJS + PostgreSQL (Drizzle). Two or more identical API instances; any can be
killed at any time. The POS is slow, flaky and **not idempotent**.

- `apps/api` – API + background sync worker (runs inside every API instance)
- `apps/fake-pos` – fake third-party POS (failure modes via env or `POST /debug/config`)
- `apps/admin` – React operator UI (POS Sync Operations)
- `tests/integration` – real Postgres + in-process fake POS; `tests/chaos` – multi-process chaos run
- Design and trade-offs: `DECISIONS.md`. Read it before changing anything under `apps/api/src/sync/`.

## Commands

```bash
npm run check          # lint + typecheck + unit tests + migration drift (= pre-commit = CI "check" job)
npm run test:int       # integration tests; needs TEST_DATABASE_URL (separate DB, it is wiped)
npm run test:chaos     # 200-check chaos run (docker if available, else CHAOS_MODE=local)
npm run db:generate -- --name <change>   # after editing apps/api/src/db/schema.ts
npm run db:migrate     # apply migrations to DATABASE_URL
npm run lint:fix       # Biome format + safe fixes
docker compose up --build                # full stack; UI at http://localhost:8080
```

## Hard rules (the sync guarantees depend on them)

1. **Never call the POS inside a DB transaction, and never from a request handler.** Handlers only
   write state; `SyncProcessor` makes POS calls between two short transactions.
2. **`create_sent_at` is committed before a create is sent.** It is cleared only when the POS proves
   nothing was created (500/429/422 per contract, refused connection, or an empty externalRef lookup
   older than `SYNC_SETTLE_MS`). Never "retry the create" on a timeout: reconcile with a lookup.
3. **A cancel is sent only for a `posOrderId` the POS returned.** That is how cancel can never
   overtake its create. Do not add a cancel path that guesses an id.
4. **All sync decisions live in `sync-machine.ts`** (pure, no I/O). Change it with a unit test in
   `sync-machine.spec.ts` first. Persist results through `finishStep`, which re-reads the row under
   lock and checks the lease token (fencing). Never write `pos_sync` from a stale snapshot.
5. **POS requests go through `PosRateLimiter.tryAcquire` in the same transaction as the step.**
   The limit is shared via Postgres; no in-memory counters.
6. **Schema changes:** edit `schema.ts`, then `npm run db:generate`. Never hand-edit or delete files
   in `apps/api/drizzle/` (a hook blocks it), never `drizzle-kit push`.
7. **Timing invariants** (`config.ts` refuses to start otherwise): `SYNC_LEASE_MS >= POS_TIMEOUT_MS +
   5000`, `SYNC_SETTLE_MS >= POS_TIMEOUT_MS`. Do not "fix" a slow test by shortening the lease.
8. The worker uses its own pool (`WORKER_DB`); request handlers use `DB`. Keep it that way so worker
   load cannot push `POST /checks/:id/pay` past 300 ms.
9. Do not weaken an assertion in `tests/chaos` or `tests/integration` to make it pass. If a guarantee
   cannot hold, say so in `DECISIONS.md`.

## Working rules

- Credentials come from `.env` (gitignored). Never read `.env`, never guess or brute-force passwords;
  if something needs a secret you do not have, stop and ask.
- A guard (test, hook, check script) is not done until you have seen it **fail** on a bad input.
- Integration tests share one database and run in a single fork; do not parallelize them.
- Imports for Nest DI must be value imports (Biome `useImportType` is off on purpose).
- Run `/review-sync` (subagent `sync-reviewer`) on any diff touching `apps/api/src/sync/` or the schema.

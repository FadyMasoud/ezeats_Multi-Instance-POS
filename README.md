# EZeats POS sync

Sends every paid check to its restaurant's POS **exactly once**, and cancels it there when the
check is cancelled. It does this even when API instances are killed, the POS times out, returns
500 or 429, or is slow. Built with NestJS, PostgreSQL (Drizzle), a fake POS, and a React operator
UI.

- [DECISIONS.md](DECISIONS.md): designs compared, why a Postgres outbox, the "timed out but maybe
  created" case, risks, scaling.
- [AI_NOTES.md](AI_NOTES.md): where Claude was wrong and how it was caught.
- [docs/IMPLEMENTATION_GUIDE.pdf](docs/IMPLEMENTATION_GUIDE.pdf): the full guide (source:
  [docs/IMPLEMENTATION_GUIDE.md](docs/IMPLEMENTATION_GUIDE.md)).

```
client ─► nginx :8080 ─► api-1 / api-2 ─► PostgreSQL (checks + pos_sync outbox)
                              │ worker in every instance (leases, SKIP LOCKED)
                              └────────► fake POS :4000
```

## Run it (fresh clone)

Prerequisites: Docker with Compose v2. For tests: Node.js 18.17+ (20 recommended) and npm.

```bash
git clone <repo-url> ezeats && cd ezeats
docker compose up --build        # postgres, migrations, fake POS, api-1, api-2, nginx + UI
```

| What | URL |
|---|---|
| Admin UI ("POS Sync Operations") | http://localhost:8080 (operator token: `dev-admin-token`) |
| Load-balanced API | http://localhost:8080/api |
| api-1 / api-2 directly | http://localhost:3001, http://localhost:3002 |
| Fake POS | http://localhost:4000 (`GET /debug/orders`) |
| Postgres | `localhost:55432`, user/password/db `ezeats` |

To turn on the POS failure modes, set them before starting:
`FAIL_RATE=0.2 TIMEOUT_AFTER_CREATE_RATE=0.1 SLOW_RATE=0.2 docker compose up --build`.
You can also change them at runtime with `POST :4000/debug/config`.

Verified on Docker Desktop 29.6 (Windows 11, Compose v5.2): every service healthy, `migrate`
exits 0, and the admin UI lists checks, filters "Failed sync" and retries through nginx.

> **Behind a TLS-inspecting proxy or antivirus** (e.g. Avast Web Shield), `npm ci` inside the
> image cannot verify the registry certificate. Pass that root CA as the optional `npm_ca` build
> secret: a compose override with `build: { secrets: [npm_ca] }` on each built service and a
> top-level `secrets: { npm_ca: { file: <path to the CA .pem> } }`.

## Tests

```bash
npm ci
npm run check        # lint + typecheck + unit tests (incl. hook tests) + migration drift
npm run test:int     # integration tests on real Postgres; needs TEST_DATABASE_URL (it is wiped)
npm run test:chaos   # chaos test (see below)
```

For integration tests without Docker, copy `.env.example` to `.env` and point
`TEST_DATABASE_URL` at an empty database. With the compose stack running, use:
`TEST_DATABASE_URL=postgres://ezeats:ezeats@localhost:55432/ezeats_test`. Create that database
first: `docker compose exec postgres createdb -U ezeats ezeats_test`.

**Chaos test.** One command: `npm run test:chaos`. It:
1. Starts the stack: `docker compose up -d --build`, or spawns local processes when Docker is
   missing or `CHAOS_MODE=local` is set. Local mode needs `DATABASE_URL` in `.env` and free ports
   3001, 3002 and 4000.
2. Turns on every POS failure mode (20% 500, 10% timeout after create, 20% slow).
3. Creates 200 checks over 20 restaurants, pays all of them, and cancels 20% (half racing the
   create).
4. `SIGKILL`s `api-1` after 80 payments and restarts it 5 seconds later.
5. Waits for every sync to finish, then checks the POS:
   - every kept check has exactly one order, and it is open;
   - every cancelled check has at most one order, and none open;
   - there are no duplicate creates and no orphan orders.

It exits non-zero on any violation.

Latest Docker-mode results: four runs in a row passed. 160 kept checks → 160 open orders, 40
cancelled → 0 open, 0 duplicates, 0 orphans, settled in 36–68 s. Pay latency p95 58–104 ms, max
83–136 ms (successful attempt; failover from the killed instance took up to 7.5 s). See [DECISIONS.md](DECISIONS.md#measured-honestly).

## Local development without Docker

```bash
npm ci
cp .env.example .env                  # set DATABASE_URL / TEST_DATABASE_URL
npm run db:migrate
npm run dev:pos                       # fake POS on :4000
PORT=3001 INSTANCE_ID=api-1 npm run dev:api
PORT=3002 INSTANCE_ID=api-2 npm run dev:api   # second instance (another terminal)
npm run dev:admin                     # UI on http://localhost:5173 (proxies /api to :3001)
```

Schema change: edit `apps/api/src/db/schema.ts`, then run `npm run db:generate -- --name <change>`.

## API

| Endpoint | Behaviour |
|---|---|
| `POST /checks` `{restaurantId, items:[{name,quantity,unitPrice}], total}` | 201, status `open` |
| `POST /checks/:id/pay` | 200; marks the check paid and queues the sync in one statement. Never calls the POS. Idempotent. 409 if cancelled |
| `POST /checks/:id/cancel` | 200; allowed while open or paid. Idempotent |
| `GET /checks/:id/sync` | Sync state, POS order id, attempts, last error (kind, HTTP status, message), next attempt, `retryable` + reason |
| `POST /checks/:id/sync/retry` | 202; operator only (`x-admin-token`). Re-queues a `failed` sync. 409 with the reason otherwise |
| `GET /admin/sync`, `/admin/sync/summary`, `/admin/checks/:id` | Operator lists, counts and details (incl. attempt history) |

```bash
B=http://localhost:8080/api
ID=$(curl -s -XPOST $B/checks -H 'content-type: application/json' \
  -d '{"restaurantId":"r1","items":[{"name":"Koshari","quantity":2,"unitPrice":45}],"total":90}' | jq -r .id)
curl -s -XPOST $B/checks/$ID/pay
curl -s $B/checks/$ID/sync | jq
curl -s -XPOST $B/checks/$ID/sync/retry -H 'x-admin-token: dev-admin-token'   # 409 unless failed
```

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | — | Postgres connection (required) |
| `POS_BASE_URL` | `http://localhost:4000` | POS endpoint |
| `ADMIN_TOKEN` | `dev-admin-token` in compose | Operator token for `/admin/*` and retry. No token = operator access denied |
| `POS_TIMEOUT_MS` / `SYNC_LEASE_MS` / `SYNC_SETTLE_MS` | 10000 / 30000 / 15000 | The API refuses to start unless lease ≥ timeout + 5 s and settle ≥ timeout |
| `SYNC_MAX_FAILURES` | 12 | Consecutive transient failures before the sync is parked as `failed` |
| `POS_RATE_LIMIT` / `POS_RATE_WINDOW_MS` / `POS_RATE_SAFETY_MS` | 5 / 10000 / 500 | Shared per-restaurant budget |
| `WORKER_CONCURRENCY`, `DB_POOL_SIZE`, `WORKER_DB_POOL_SIZE` | 32, 10, 5 | Separate pools for requests and the worker |
| `FAIL_RATE`, `TIMEOUT_AFTER_CREATE_RATE`, `SLOW_RATE` | 0 | Fake POS failure modes (0–1) |

## Claude Code setup

`CLAUDE.md` holds the project rules. `.claude/settings.json` sets the permissions: allow
checks, tests, git read and `git add`; ask before commits, installs, Docker and config edits;
deny reading `.env`, force-push, `reset --hard`, `drizzle-kit push`, `rm -rf` and edits to
migrations.

| Hook | What it does, and why |
|---|---|
| `PreToolUse` → `guard-commands.mjs` (blocks) | Blocks skipping the pre-commit hook, force-push, `reset --hard`, rebase/amend, `drizzle-kit push`, destructive SQL, `compose down -v`, recursive deletes, literal DB credentials, and printing `.env`. Added because these are irreversible or hide problems; the credential rule came from a real password-guessing attempt (AI_NOTES). |
| `PreToolUse` → `guard-files.mjs` (blocks) | Blocks reading or editing `.env*` (except `.env.example`), editing generated migrations, and hand-editing `package-lock.json`. Migrations must come from the schema. |
| `PostToolUse` → `check-edit.mjs` (checks) | After each edit: Biome on the file, a typecheck of its workspace, and the migration-drift check when `schema.ts` changes. Errors go straight back to Claude. |
| `Stop` → `verify-stop.mjs` (checks) | If source files changed, runs `npm run check` before Claude may finish. |
| git `pre-commit` (Husky) | Runs `npm run check`, the same command as the CI `check` job. CI additionally runs integration tests and the Docker chaos test (`.github/workflows/ci.yml`). |

All hooks are plain Node scripts: they work on a fresh clone after `npm ci`, on macOS, Linux and
Windows, and they are covered by `tests/hooks`. `/review-sync` runs the `sync-reviewer` subagent
(`.claude/agents/sync-reviewer.md`), which checks a diff against the sync correctness rules. It
was used on this codebase and found a real duplicate-order bug (AI_NOTES #1).

## Known limitations

- Exactly-once depends on the POS lookup being truthful. See DECISIONS.md, "Risk that remains".
- In local chaos mode (every process on one laptop) the pay p100 exceeded 300 ms under the
  20-client load. In Docker mode it stayed under 140 ms (successful attempt).
- The operator token is a local-development stand-in, not authentication.
- The fake POS keeps its orders in memory; restarting it loses them.

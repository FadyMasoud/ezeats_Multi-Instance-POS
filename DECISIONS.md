# DECISIONS

## The problem in one line

We must turn "check paid" into **exactly one** order on a POS that is slow, fails, rate-limits,
and is **not idempotent**, from several API instances that can die at any instruction.
Exactly-once delivery is impossible over such a POS in general. What we can build is
*at-least-once attempts* plus *reconciliation by `externalRef`*, which turns into exactly-once
as long as the POS's own lookup tells the truth. The design decides where the unavoidable
uncertainty sits and keeps it small.

## Designs considered

| | A. Call the POS inside `POST /pay` | **B. Postgres outbox + leased workers (chosen)** | C. Outbox + BullMQ/Redis queue |
|---|---|---|---|
| Pay latency | POS-bound (3–15 s), fails when POS is down | One DB statement (POS never on the path) | Same as B |
| Crash safety | Instance dies after POS created → no record → retry duplicates | `create_sent_at` committed before sending; lease expiry hands the row to another instance, which looks the order up first | Job and DB state can disagree (job acked/lost vs row committed); needs its own outbox relay anyway |
| Ordering create → cancel | Two requests can race on two instances | One row per check; one lease at a time; cancel only for an id the POS returned | Needs per-check grouping / job dedupe; cancel and create are separate jobs that can reorder |
| Shared rate limit | Per-instance counters, not shared | Sliding window in Postgres + per-restaurant advisory lock | Redis limiter is natural here (a real plus) |
| Moving parts | None | Postgres only | Postgres + Redis + a relay between them |
| Where it breaks | Every guarantee except "simple" | Polling cost and DB load at very high volume; Postgres is the bottleneck | Two sources of truth; Redis loss or job/row skew causes lost or duplicate work |

I also considered **D. a single elected leader per restaurant** (advisory-lock leader that owns all
POS traffic for a restaurant). It makes rate limiting and ordering trivial, but a dead leader
stalls a whole restaurant until failover, and it still needs B's durable state underneath.

**Why B.** Every guarantee depends on one fact: what was committed before a POS request left. In
B that fact lives in the same row and transaction as the check itself, so there is one source of
truth and no relay. Redis would only give us a faster limiter and push-based wake-ups; at this
volume (5 requests per 10 s per restaurant) polling every 250 ms is cheap, and the limiter in
Postgres is exact across instances. A queue does not remove the hard part (ambiguous POS outcomes);
it adds a second place where state can disagree.

## How B works

- `POST /checks/:id/pay`: one SQL statement updates the check `open → paid` and inserts its
  `pos_sync` row (the outbox + state machine). Idempotent; never touches the POS.
- Every API instance runs a worker. It **claims** due rows with `FOR UPDATE SKIP LOCKED`, at most
  one per restaurant per claim (fairness), skipping throttled restaurants, and sets a
  **lease** (`lease_token`, 30 s).
- Each step is: short transaction (re-read row under lock, check lease token, decide the next
  action, take a rate-limit token, for a create commit `create_sent_at`) → **one** POS request with
  no transaction open → short transaction (re-read the *fresh* row, check the lease token again,
  apply the outcome, release the lease). All decisions are a pure function (`sync-machine.ts`).
- The worker uses its own connection pool so worker load never queues `pay` behind it.

## "Timed out, but maybe created"

`create_sent_at` is written and committed **before** the create is sent. From then on, a create is
only sent again once the POS has proven the previous one did not create anything:

- **Proven not created:** 500, 429, 422 (the POS contract), and a refused connection.
- **Ambiguous:** timeout, connection reset, other 4xx (could be a proxy), 3xx, 502–504, 2xx
  without an id, an instance crash at any point. The next step is a lookup:
  `GET /orders?externalRef=<checkId>`.
  - If it finds an open order, we adopt it. If it finds several, we keep the oldest and cancel the
    others.
  - If it finds nothing, we only trust that when the lookup was **sent** at least
    `SYNC_SETTLE_MS` (15 s) after `create_sent_at`. Otherwise we look again later. After that, a
    new create is allowed.
- Leases (30 s) are longer than the POS timeout (10 s) + 5 s, and the settle window is at least
  the timeout. `config.ts` refuses to start otherwise, so a second instance cannot take over a row
  while the first one's request may still be in flight.

**Risk that remains.** If the POS lookup is wrong (eventually consistent, or a create lands more
than 15 s after it was sent), we may create a second order. If a later lookup sees two orders, we
keep one open and cancel the other. Nothing re-checks a check that is already `synced`, so a
duplicate that lands later still needs an operator. Exactly-once therefore depends on the POS
lookup being truthful; with a non-idempotent POS no design can do better without the POS's help
(an idempotency key, or a unique `externalRef`).

## Cancel ordering

A cancel is sent only for a `posOrderId` that came from the POS (a create response or a lookup),
so it can never reach the POS before the create it cancels. A check cancelled before
`create_sent_at` was ever committed is closed with no POS call at all. The race with a worker that
is about to send is decided by the row lock: whichever commits first wins, and the worker re-reads
`cancel_requested` before sending. If the create may already have been sent, we look it up first
and then cancel what we find.

## Rate limit and fairness

Every POS request (create, lookup, cancel) takes a token from a Postgres sliding window: 5 per
10.5 s per restaurant, serialized by a per-restaurant advisory lock, shared by all instances.
A 429 from the POS, or an empty budget, blocks that restaurant on **every** instance until a slot
frees up. 429s do not consume the retry budget. The claim query picks one row per restaurant per
cycle and skips throttled restaurants, so a busy restaurant only delays itself.

**Known gap:** a token is taken when the request is *prepared*, but the POS counts *arrivals*.
The 0.5 s margin covers normal latency; if it is exceeded, the 429 is handled as back-pressure.

## Failure handling and visibility

Each failed POS call is classified (server error, rate limited, rejected, timeout, network,
unexpected) and backed off exponentially with jitter. A 422 or other permanent rejection, or 12
consecutive transient failures, parks the row as `failed`. `GET /checks/:id/sync` and the admin UI
show the reason and every attempt. `POST /checks/:id/sync/retry` (operator token) only re-queues
the row; the worker still reconciles first. Cancelling a `failed` check resumes the row so that
the cancel is carried out.

## Assumptions

- `externalRef` = check id.
- The POS lookup returns every order for a ref.
- POS cancel is idempotent.
- `POST /checks` accepts `total <= 0` on purpose, so the 422 path can be reached.
- The retry endpoint uses a shared local-development token, not real authentication.
- Lookups are counted against the restaurant's budget, even though the fake POS cannot attribute
  them to a restaurant.

## Measured, honestly

Three local chaos runs (200 checks, 20% fail, 10% timeout-after-create, 20% slow, `api-1` force
killed mid-run and restarted) passed the three POS invariants. The latest run also failed on any
duplicate create, and found none.

`POST /pay` latency in the latest run, with 20 concurrent clients during the kill and every
service on one laptop:

| | Latency |
|---|---|
| p50 | 114 ms |
| p95 | 298 ms |
| max | 472 ms |

So **the < 300 ms guarantee is not met at the tail under that load**. Integration tests (POS down,
or slow) stay under 300 ms. The Docker Compose path was written but could not be run on the
authoring machine (no Docker). Its runtime image contents were verified by running the
production-only install against a fresh database.

## At 100× volume

- Replace polling with `LISTEN/NOTIFY` wake-ups plus slower polling.
- Partition `pos_sync` by state, or move finished rows to an archive table so the claim index
  stays small.
- Keep the request log in an in-memory store, or switch to a token bucket per restaurant held in
  one row (`UPDATE … RETURNING`).
- Batch the attempt-history inserts.
- Run workers as a separate deployment so request handling and POS I/O scale independently.
- Add per-restaurant concurrency caps, metrics and alerts (failed count, age of oldest due row,
  429 rate).
- Ask the POS vendor for an idempotency key. That one change removes most of this complexity.

## With another day

- Run the Docker chaos path in CI.
- Add a post-sync verification lookup to catch late duplicates.
- Cut `pay` to one round trip, and profile its tail latency on separate hosts.
- Add real operator auth with an audit log of manual retries.
- Add property-based tests for the state machine.

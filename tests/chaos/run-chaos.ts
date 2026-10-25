/**
 * Chaos test: two API instances, every POS failure mode on, >= 200 checks, ~20% cancelled,
 * one API instance SIGKILLed mid-run and restarted, then the POS is checked for:
 *   - every paid, non-cancelled check has exactly one open POS order
 *   - every cancelled check has no open POS order
 *   - no POS order exists that does not belong to one of our checks
 *
 *   npm run test:chaos                 # docker mode if `docker compose` works, else local
 *   CHAOS_MODE=local npm run test:chaos  # spawn fake POS + 2 APIs as local processes
 */
import { type ChildProcess, execSync, spawn, spawnSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';

const ROOT = resolve(__dirname, '..', '..');
loadDotenv({ path: resolve(ROOT, '.env') });

const env = process.env;
const num = (key: string, fallback: number) => (env[key] ? Number(env[key]) : fallback);

const SETTINGS = {
  checks: num('CHAOS_CHECKS', 200),
  restaurants: num('CHAOS_RESTAURANTS', 20),
  cancelRatio: num('CHAOS_CANCEL_RATIO', 0.2),
  settleTimeoutMs: num('CHAOS_SETTLE_TIMEOUT_MS', 10 * 60_000),
  killAfterPaid: num('CHAOS_KILL_AFTER', 0.4),
  restartAfterMs: num('CHAOS_RESTART_AFTER_MS', 5_000),
  failures: {
    failRate: num('CHAOS_FAIL_RATE', 0.2),
    timeoutAfterCreateRate: num('CHAOS_TIMEOUT_AFTER_CREATE_RATE', 0.1),
    slowRate: num('CHAOS_SLOW_RATE', 0.2),
  },
  adminToken: env.ADMIN_TOKEN || 'dev-admin-token',
};

const POS_URL = env.CHAOS_POS_URL || 'http://localhost:4000';
const API_URLS = [
  env.CHAOS_API1_URL || 'http://localhost:3001',
  env.CHAOS_API2_URL || 'http://localhost:3002',
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (msg: string) =>
  console.log(`[chaos ${new Date().toISOString().slice(11, 19)}] ${msg}`);

// ---------------------------------------------------------------------------------------------
// Process control: docker compose or local child processes
// ---------------------------------------------------------------------------------------------

interface Cluster {
  start(): Promise<void>;
  kill(index: number): Promise<void>;
  restart(index: number): Promise<void>;
  stop(): Promise<void>;
}

function dockerAvailable(): boolean {
  return spawnSync('docker', ['compose', 'version'], { stdio: 'ignore', shell: true }).status === 0;
}

class DockerCluster implements Cluster {
  private readonly services = ['api-1', 'api-2'];
  /**
   * Async on purpose: kill/start run while payments are in flight, and a blocking execSync
   * (~1 s for `docker compose kill`) froze this process, adding that second to every in-flight
   * request's measured pay latency.
   */
  private sh(cmd: string): Promise<void> {
    log(`$ ${cmd}`);
    return new Promise((done, fail) => {
      spawn(cmd, { cwd: ROOT, stdio: 'inherit', shell: true })
        .on('error', fail)
        .on('exit', (code) => (code === 0 ? done() : fail(new Error(`${cmd} exited ${code}`))));
    });
  }
  async start() {
    // No --wait: the one-shot migrate service exits by design; health is awaited over HTTP below.
    await this.sh('docker compose up -d --build');
  }
  async kill(i: number) {
    await this.sh(`docker compose kill -s SIGKILL ${this.services[i]}`);
  }
  async restart(i: number) {
    await this.sh(`docker compose start ${this.services[i]}`);
  }
  async stop() {
    log('docker stack left running (docker compose down to stop it)');
  }
}

class LocalCluster implements Cluster {
  private readonly apis: (ChildProcess | null)[] = [null, null];
  private pos: ChildProcess | null = null;
  private readonly logDir = resolve(ROOT, '.chaos');

  private spawnNode(name: string, script: string, extraEnv: Record<string, string>): ChildProcess {
    const out = createWriteStream(resolve(this.logDir, `${name}.log`), { flags: 'a' });
    const child = spawn(process.execPath, [script], {
      cwd: ROOT,
      env: { ...process.env, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.pipe(out);
    child.stderr?.pipe(out);
    return child;
  }

  private spawnApi(i: number) {
    const port = new URL(API_URLS[i] ?? '').port;
    this.apis[i] = this.spawnNode(`api-${i + 1}`, 'apps/api/dist/main.js', {
      PORT: port,
      INSTANCE_ID: `api-${i + 1}`,
      POS_BASE_URL: POS_URL,
      ADMIN_TOKEN: SETTINGS.adminToken,
    });
  }

  async start() {
    mkdirSync(this.logDir, { recursive: true });
    log('building api and fake POS');
    execSync('npm run build -w apps/api -w apps/fake-pos', { cwd: ROOT, stdio: 'ignore' });
    execSync('npm run db:migrate', { cwd: ROOT, stdio: 'ignore' });
    for (const url of [POS_URL, ...API_URLS]) {
      if (await healthy(url))
        throw new Error(`${url} is already in use; stop it or use CHAOS_MODE=docker`);
    }
    this.pos = this.spawnNode('fake-pos', 'apps/fake-pos/dist/main.js', {
      PORT: new URL(POS_URL).port,
      FAIL_RATE: String(SETTINGS.failures.failRate),
      TIMEOUT_AFTER_CREATE_RATE: String(SETTINGS.failures.timeoutAfterCreateRate),
      SLOW_RATE: String(SETTINGS.failures.slowRate),
    });
    this.spawnApi(0);
    this.spawnApi(1);
  }

  async kill(i: number) {
    this.apis[i]?.kill('SIGKILL');
    this.apis[i] = null;
  }

  async restart(i: number) {
    this.spawnApi(i);
  }

  async stop() {
    for (const child of [...this.apis, this.pos]) child?.kill('SIGKILL');
    log(`process logs in ${this.logDir}`);
  }
}

// ---------------------------------------------------------------------------------------------
// HTTP helpers. The test plays the load balancer: it fails over to the other instance when one
// is down, and retries requests that are safe to retry.
// ---------------------------------------------------------------------------------------------

async function http(method: string, url: string, body?: unknown, timeoutMs = 10_000) {
  const res = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json', 'x-admin-token': SETTINGS.adminToken },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function healthy(base: string): Promise<boolean> {
  try {
    return (await http('GET', `${base}/health`, undefined, 2_000)).status === 200;
  } catch {
    return false;
  }
}

async function waitHealthy(bases: string[], timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  for (const base of bases) {
    while (!(await healthy(base))) {
      if (Date.now() > deadline) throw new Error(`${base} did not become healthy`);
      await sleep(500);
    }
  }
}

/** A 4xx answer: our request was wrong, retrying elsewhere would not help. */
class ClientError extends Error {}

let rr = 0;
/**
 * Sends to API instances round-robin, failing over on connection errors and 5xx. Only used for
 * requests that are safe to repeat (pay/cancel are idempotent; a repeated create just leaves an
 * extra open, unpaid check that never reaches the POS).
 */
async function api(method: string, path: string, body?: unknown) {
  return (await apiTimed(method, path, body)).body;
}

/** Like api(), also reporting how long the attempt that succeeded took (excludes failover). */
async function apiTimed(method: string, path: string, body?: unknown) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 40; attempt++) {
    const base = API_URLS[rr++ % API_URLS.length] ?? '';
    try {
      const started = performance.now();
      const res = await http(method, `${base}${path}`, body);
      if (res.status < 300)
        return { body: res.body, ms: performance.now() - started, attempts: attempt + 1 };
      if (res.status < 500)
        throw new ClientError(`${method} ${path} -> ${res.status} ${JSON.stringify(res.body)}`);
      lastError = new Error(`${method} ${path} -> ${res.status}`);
    } catch (error) {
      if (error instanceof ClientError) throw error;
      lastError = error;
    }
    await sleep(100 + attempt * 50);
  }
  throw lastError;
}

async function pool<T>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<void>,
) {
  let next = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (next < items.length) {
        const i = next++;
        await fn(items[i] as T, i);
      }
    }),
  );
}

// ---------------------------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------------------------

interface SyncStatus {
  checkId: string;
  state: string | null;
  posOrderId: string | null;
  lastError: { kind: string; message: string } | null;
}
interface PosOrder {
  posOrderId: string;
  externalRef: string;
  status: 'open' | 'cancelled';
}

const TERMINAL = new Set(['synced', 'cancelled', 'failed']);

async function waitForIdle() {
  const deadline = Date.now() + 120_000;
  for (;;) {
    const s = await api('GET', '/admin/sync/summary');
    const active = s.pending + s.retrying;
    if (active === 0) return;
    if (Date.now() > deadline)
      throw new Error(`${active} syncs from an earlier run are still active`);
    log(`waiting for ${active} active syncs from an earlier run to finish`);
    await sleep(3_000);
  }
}

async function main() {
  const mode = env.CHAOS_MODE || (dockerAvailable() ? 'docker' : 'local');
  log(
    `mode=${mode} checks=${SETTINGS.checks} restaurants=${SETTINGS.restaurants} failures=${JSON.stringify(SETTINGS.failures)}`,
  );
  const cluster: Cluster = mode === 'docker' ? new DockerCluster() : new LocalCluster();

  let exitCode = 1;
  try {
    await cluster.start();
    await waitHealthy([POS_URL, ...API_URLS]);
    await waitForIdle();
    await http('POST', `${POS_URL}/debug/reset`);
    await http('POST', `${POS_URL}/debug/config`, {
      ...SETTINGS.failures,
      timeoutAfterCreateDelayMs: 15_000,
    });
    log('POS reset; all failure modes on');

    // 1. Create checks.
    const runTag = Date.now().toString(36);
    const ids: string[] = [];
    await pool(
      Array.from({ length: SETTINGS.checks }, (_, i) => i),
      20,
      async (i) => {
        const unitPrice = 25 + (i % 7) * 10.5;
        const quantity = 1 + (i % 3);
        const check = await api('POST', '/checks', {
          restaurantId: `chaos-${runTag}-r${String(i % SETTINGS.restaurants).padStart(2, '0')}`,
          items: [{ name: `Item ${i}`, quantity, unitPrice }],
          total: Math.round(unitPrice * quantity * 100) / 100,
        });
        ids.push(check.id);
      },
    );
    log(`created ${ids.length} checks`);

    // 2. Pay all of them; kill api-1 part-way through, restart it a few seconds later.
    const toCancel = new Set(ids.filter((_, i) => i % Math.round(1 / SETTINGS.cancelRatio) === 0));
    const killAt = Math.floor(ids.length * SETTINGS.killAfterPaid);
    let paid = 0;
    const restarts: Promise<void>[] = [];
    const cancelLater: string[] = [];
    const payLatencies: number[] = [];
    const payWithFailover: number[] = [];

    await pool(ids, 20, async (id, i) => {
      const started = performance.now();
      const res = await apiTimed('POST', `/checks/${id}/pay`);
      payLatencies.push(res.ms);
      payWithFailover.push(performance.now() - started);
      paid++;
      if (paid === killAt) {
        log(`SIGKILL api-1 after ${paid} payments`);
        await cluster.kill(0);
        const restart = sleep(SETTINGS.restartAfterMs).then(async () => {
          log('restarting api-1');
          await cluster.restart(0);
          await waitHealthy([API_URLS[0] ?? '']);
          log('api-1 healthy again');
        });
        // A failure is rethrown by Promise.all(restarts) below; without this it would crash the
        // process as an unhandled rejection first, skipping the result log.
        restart.catch(() => {});
        restarts.push(restart);
      }
      if (toCancel.has(id)) {
        // Half are cancelled immediately (racing the create), half after it probably synced.
        if (i % 2 === 0) await api('POST', `/checks/${id}/cancel`);
        else cancelLater.push(id);
      }
    });
    log(
      `paid ${paid} checks; pay latency p50=${pct(payLatencies, 50)}ms p95=${pct(payLatencies, 95)}ms ` +
        `max=${pct(payLatencies, 100)}ms (incl. client failover to the surviving instance: ` +
        `p95=${pct(payWithFailover, 95)}ms max=${pct(payWithFailover, 100)}ms)`,
    );

    await sleep(3_000);
    await pool(cancelLater, 10, async (id) => {
      await api('POST', `/checks/${id}/cancel`);
    });
    log(
      `cancelled ${toCancel.size} checks (${toCancel.size - cancelLater.length} immediately, ${cancelLater.length} later)`,
    );
    await Promise.all(restarts);

    // 3. Wait for every sync to reach a terminal state.
    const started = Date.now();
    let statuses: SyncStatus[] = [];
    for (;;) {
      statuses = [];
      await pool(ids, 20, async (id) => {
        statuses.push(await api('GET', `/checks/${id}/sync`));
      });
      const counts = countBy(statuses.map((s) => s.state ?? 'none'));
      const done = statuses.every((s) => s.state && TERMINAL.has(s.state));
      log(`settling ${Math.round((Date.now() - started) / 1000)}s: ${JSON.stringify(counts)}`);
      if (done) break;
      if (Date.now() - started > SETTINGS.settleTimeoutMs)
        throw new Error('timed out waiting for syncs to settle');
      await sleep(5_000);
    }

    // 4. Check the POS.
    const orders: PosOrder[] = (await http('GET', `${POS_URL}/debug/orders`)).body;
    exitCode = verify(ids, toCancel, statuses, orders) ? 0 : 1;
  } catch (error) {
    console.error(error);
  } finally {
    await cluster.stop();
  }
  process.exit(exitCode);
}

function verify(
  ids: string[],
  cancelled: Set<string>,
  statuses: SyncStatus[],
  orders: PosOrder[],
): boolean {
  const ours = new Set(ids);
  const byRef = new Map<string, PosOrder[]>();
  for (const o of orders) byRef.set(o.externalRef, [...(byRef.get(o.externalRef) ?? []), o]);
  const statusById = new Map(statuses.map((s) => [s.checkId, s]));
  const failures: string[] = [];

  for (const id of ids) {
    const all = byRef.get(id) ?? [];
    const open = all.filter((o) => o.status === 'open');
    const status = statusById.get(id);
    // The fake POS never creates on a 500 and commits before any delay, so a second order for the
    // same check is a duplicate create, even if the sync later cancelled ("healed") it.
    if (all.length > 1) {
      failures.push(`check ${id} was created ${all.length} times on the POS (duplicate create)`);
    }
    if (cancelled.has(id)) {
      if (open.length !== 0)
        failures.push(`cancelled check ${id} has ${open.length} open POS order(s)`);
    } else {
      if (open.length !== 1) {
        failures.push(
          `paid check ${id} has ${open.length} open POS orders (sync=${status?.state} ${status?.lastError?.message ?? ''})`,
        );
      } else if (status?.posOrderId !== open[0]?.posOrderId) {
        failures.push(
          `check ${id}: sync says ${status?.posOrderId}, POS open order is ${open[0]?.posOrderId}`,
        );
      }
    }
  }
  const orphans = orders.filter((o) => !ours.has(o.externalRef));
  if (orphans.length) failures.push(`${orphans.length} POS order(s) do not belong to our checks`);

  const healedDuplicates = orders.filter(
    (o) => !cancelled.has(o.externalRef) && o.status === 'cancelled',
  ).length;
  log('---------------- result ----------------');
  log(
    `checks: ${ids.length}  paid & kept: ${ids.length - cancelled.size}  cancelled: ${cancelled.size}`,
  );
  log(
    `POS orders: ${orders.length}  open: ${orders.filter((o) => o.status === 'open').length}  duplicates healed: ${healedDuplicates}`,
  );
  log(`sync states: ${JSON.stringify(countBy(statuses.map((s) => s.state ?? 'none')))}`);
  if (failures.length) {
    for (const f of failures.slice(0, 30)) log(`FAIL ${f}`);
    log(`CHAOS TEST FAILED (${failures.length} violation(s))`);
    return false;
  }
  log(
    'CHAOS TEST PASSED: exactly one POS order per kept check (open), at most one per cancelled check (none open), no duplicates, no orphans',
  );
  return true;
}

function countBy(values: string[]): Record<string, number> {
  return values.reduce<Record<string, number>>((acc, v) => {
    acc[v] = (acc[v] ?? 0) + 1;
    return acc;
  }, {});
}

function pct(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(
    sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0,
  );
}

if (!existsSync(resolve(ROOT, 'package.json'))) throw new Error('run from the repository');
void main();

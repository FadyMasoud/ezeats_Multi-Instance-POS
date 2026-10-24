import { resolve } from 'node:path';
import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { config as loadDotenv } from 'dotenv';
import { sql } from 'drizzle-orm';
import request from 'supertest';
import { AppModule } from '../../apps/api/src/app.module';
import { configureApp } from '../../apps/api/src/bootstrap';
import {
  type AppConfig,
  type RateLimitConfig,
  type WorkerConfig,
  assertSafeTimings,
} from '../../apps/api/src/config';
import { DB, type Database } from '../../apps/api/src/db/database';
import type { SyncStatusDto } from '../../apps/api/src/sync/sync-status.dto';
import { SyncWorker } from '../../apps/api/src/sync/sync-worker.service';
import { FakePosModule } from '../../apps/fake-pos/src/app.module';
import {
  type FailureConfig,
  type PosConfig,
  loadPosConfig,
} from '../../apps/fake-pos/src/pos-config';
import { PosStore } from '../../apps/fake-pos/src/pos-store';

loadDotenv({ path: resolve(__dirname, '..', '..', '.env') });

export const ADMIN_TOKEN = 'test-admin-token';
/** Short windows keep the suite fast while exercising the same code paths. */
export const RATE_WINDOW_MS = 1_000;

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface FakePos {
  url: string;
  store: PosStore;
  failures: FailureConfig;
  setFailures(patch: Partial<FailureConfig>): void;
  close(): Promise<void>;
}

export async function startFakePos(overrides: Partial<PosConfig> = {}): Promise<FakePos> {
  const base = loadPosConfig({});
  const config: PosConfig = {
    ...base,
    rateWindowMs: RATE_WINDOW_MS,
    ...overrides,
    failures: {
      ...base.failures,
      slowMinMs: 150,
      slowMaxMs: 300,
      timeoutAfterCreateDelayMs: 1_500,
      ...overrides.failures,
    },
  };
  const moduleRef = await Test.createTestingModule({
    imports: [FakePosModule.forRoot(config)],
  }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  await app.listen(0, '127.0.0.1');
  const address = app.getHttpServer().address() as { port: number };
  return {
    url: `http://127.0.0.1:${address.port}`,
    store: app.get(PosStore),
    failures: config.failures,
    setFailures: (patch) => Object.assign(config.failures, patch),
    close: () => app.close(),
  };
}

export interface ApiInstance {
  app: INestApplication;
  http: ReturnType<typeof request>;
  worker: SyncWorker;
  db: Database;
  config: AppConfig;
  close(): Promise<void>;
}

export type ApiOverrides = Partial<Omit<AppConfig, 'worker' | 'rateLimit'>> & {
  worker?: Partial<WorkerConfig>;
  rateLimit?: Partial<RateLimitConfig>;
};

export function testConfig(posBaseUrl: string, overrides: ApiOverrides = {}): AppConfig {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL is required');
  const config: AppConfig = {
    instanceId: 'test-a',
    port: 0,
    databaseUrl: url,
    posBaseUrl,
    adminToken: ADMIN_TOKEN,
    ...overrides,
    worker: {
      enabled: false, // tests drive the worker with tick()/drain()
      pollIntervalMs: 20,
      maxConcurrency: 16,
      leaseMs: 6_000,
      posTimeoutMs: 700,
      ambiguousSettleMs: 900,
      reconcileDelayMs: 50,
      maxConsecutiveFailures: 6,
      backoffBaseMs: 20,
      backoffMaxMs: 100,
      ...overrides.worker,
    },
    // The margin covers acquire->arrival latency (token taken before the request leaves). In-process
    // tests share one event loop with the fake POS, so it is proportionally larger than in prod.
    rateLimit: {
      maxRequests: 5,
      windowMs: RATE_WINDOW_MS,
      safetyMarginMs: 200,
      ...overrides.rateLimit,
    },
  };
  assertSafeTimings(config.worker);
  return config;
}

export async function startApi(
  posBaseUrl: string,
  overrides: ApiOverrides = {},
): Promise<ApiInstance> {
  const config = testConfig(posBaseUrl, overrides);
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule.forRoot(config)],
  }).compile();
  const app = configureApp(moduleRef.createNestApplication({ logger: ['error'] }));
  await app.listen(0, '127.0.0.1');
  const address = app.getHttpServer().address() as { port: number };
  return {
    app,
    http: request(`http://127.0.0.1:${address.port}`),
    worker: app.get(SyncWorker),
    db: app.get<Database>(DB),
    config,
    close: () => app.close(),
  };
}

export async function truncateAll(db: Database): Promise<void> {
  await db.execute(
    sql`TRUNCATE checks, check_items, pos_sync, pos_sync_attempts, pos_rate_events, pos_restaurant_throttle RESTART IDENTITY CASCADE`,
  );
}

let restaurantSeq = 0;
/** A restaurant id unique to this test run, so rate-limit windows never leak between tests. */
export const uniqueRestaurant = (label = 'r') =>
  `${label}-${Date.now().toString(36)}-${++restaurantSeq}`;

export async function createCheck(
  api: ApiInstance,
  restaurantId: string,
  total = 120.5,
): Promise<string> {
  const res = await api.http
    .post('/checks')
    .send({ restaurantId, items: [{ name: 'Koshari', quantity: 1, unitPrice: total }], total })
    .expect(201);
  return res.body.id as string;
}

export async function createPaidCheck(
  api: ApiInstance,
  restaurantId: string,
  total = 120.5,
): Promise<string> {
  const id = await createCheck(api, restaurantId, total);
  await api.http.post(`/checks/${id}/pay`).expect(200);
  return id;
}

export async function syncOf(api: ApiInstance, id: string): Promise<SyncStatusDto> {
  const res = await api.http.get(`/checks/${id}/sync`).expect(200);
  return res.body as SyncStatusDto;
}

const TERMINAL = new Set(['synced', 'cancelled', 'failed']);

/** Ticks every worker until all given checks reach a terminal sync state. */
export async function settle(
  apis: ApiInstance[],
  ids: string[],
  timeoutMs = 30_000,
): Promise<SyncStatusDto[]> {
  const deadline = Date.now() + timeoutMs;
  const [first] = apis;
  if (!first) throw new Error('settle needs at least one API instance');
  for (;;) {
    await Promise.all(apis.map((a) => a.worker.tick()));
    await Promise.all(apis.map((a) => a.worker.drain()));
    const statuses = await Promise.all(ids.map((id) => syncOf(first, id)));
    if (statuses.every((s) => s.state !== null && TERMINAL.has(s.state))) return statuses;
    if (Date.now() > deadline) {
      const stuck = statuses.filter((s) => !s.state || !TERMINAL.has(s.state));
      throw new Error(`sync did not settle: ${JSON.stringify(stuck.slice(0, 3), null, 2)}`);
    }
    await sleep(25);
  }
}

export function openOrdersFor(pos: FakePos, externalRef: string) {
  return pos.store.findByExternalRef(externalRef).filter((o) => o.status === 'open');
}

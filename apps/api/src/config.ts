import { hostname } from 'node:os';

export interface WorkerConfig {
  enabled: boolean;
  pollIntervalMs: number;
  maxConcurrency: number;
  /** How long a claimed row stays owned. Must comfortably exceed one POS call. */
  leaseMs: number;
  /** Client-side timeout for a single POS HTTP request. */
  posTimeoutMs: number;
  /**
   * Minimum age of create_sent_at before an empty externalRef lookup is trusted as
   * "the create never landed". Guards against a create still in flight.
   */
  ambiguousSettleMs: number;
  /** Delay before looking up a create whose response timed out. */
  reconcileDelayMs: number;
  /** Consecutive transient failures before a sync is parked as failed. */
  maxConsecutiveFailures: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
}

export interface RateLimitConfig {
  maxRequests: number;
  windowMs: number;
  /** Extra window padding so network jitter cannot push a 6th request into the POS window. */
  safetyMarginMs: number;
}

export interface AppConfig {
  instanceId: string;
  port: number;
  databaseUrl: string;
  dbPoolSize: number;
  workerDbPoolSize: number;
  posBaseUrl: string;
  adminToken: string;
  worker: WorkerConfig;
  rateLimit: RateLimitConfig;
}

function int(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`Environment variable ${key} must be a non-negative integer, got "${raw}"`);
  }
  return value;
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!value) throw new Error(`Environment variable ${key} is required`);
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const config: AppConfig = {
    instanceId: env.INSTANCE_ID || `${hostname()}-${process.pid}`,
    port: int(env, 'PORT', 3000),
    databaseUrl: required(env, 'DATABASE_URL'),
    dbPoolSize: int(env, 'DB_POOL_SIZE', 10),
    workerDbPoolSize: int(env, 'WORKER_DB_POOL_SIZE', 5),
    posBaseUrl: (env.POS_BASE_URL || 'http://localhost:4000').replace(/\/+$/, ''),
    adminToken: env.ADMIN_TOKEN ?? '',
    worker: {
      enabled: env.WORKER_ENABLED !== 'false',
      pollIntervalMs: int(env, 'WORKER_POLL_MS', 250),
      maxConcurrency: int(env, 'WORKER_CONCURRENCY', 32),
      leaseMs: int(env, 'SYNC_LEASE_MS', 30_000),
      posTimeoutMs: int(env, 'POS_TIMEOUT_MS', 10_000),
      ambiguousSettleMs: int(env, 'SYNC_SETTLE_MS', 15_000),
      reconcileDelayMs: int(env, 'SYNC_RECONCILE_DELAY_MS', 2_000),
      maxConsecutiveFailures: int(env, 'SYNC_MAX_FAILURES', 12),
      backoffBaseMs: int(env, 'SYNC_BACKOFF_BASE_MS', 1_000),
      backoffMaxMs: int(env, 'SYNC_BACKOFF_MAX_MS', 30_000),
    },
    rateLimit: {
      maxRequests: int(env, 'POS_RATE_LIMIT', 5),
      windowMs: int(env, 'POS_RATE_WINDOW_MS', 10_000),
      safetyMarginMs: int(env, 'POS_RATE_SAFETY_MS', 500),
    },
  };
  assertSafeTimings(config.worker);
  return config;
}

/**
 * The duplicate-prevention argument relies on these inequalities; refuse to start without them.
 * - A lease must outlive the POS call it covers, otherwise a second instance could reclaim the
 *   row and look up the externalRef while the first instance's create is still in flight.
 * - The settle window must outlive the POS timeout for the same reason.
 */
export function assertSafeTimings(worker: WorkerConfig): void {
  if (worker.leaseMs < worker.posTimeoutMs + 5_000) {
    throw new Error('SYNC_LEASE_MS must be at least POS_TIMEOUT_MS + 5000');
  }
  if (worker.ambiguousSettleMs < worker.posTimeoutMs) {
    throw new Error('SYNC_SETTLE_MS must be at least POS_TIMEOUT_MS');
  }
  if (worker.maxConcurrency < 1) throw new Error('WORKER_CONCURRENCY must be >= 1');
}

export const APP_CONFIG = Symbol('APP_CONFIG');

export interface FailureConfig {
  /** Probability of answering 500 without doing anything. */
  failRate: number;
  /** Probability of creating the order, then answering only after timeoutAfterCreateDelayMs. */
  timeoutAfterCreateRate: number;
  /** Probability of answering correctly after a random 3-8 s delay. */
  slowRate: number;
  timeoutAfterCreateDelayMs: number;
  slowMinMs: number;
  slowMaxMs: number;
}

export interface PosConfig {
  port: number;
  rateLimit: number;
  rateWindowMs: number;
  failures: FailureConfig;
}

function rate(env: NodeJS.ProcessEnv, key: string): number {
  const value = Number(env[key] ?? 0);
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${key} must be a number between 0 and 1`);
  }
  return value;
}

function int(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  return raw === undefined || raw === '' ? fallback : Number.parseInt(raw, 10);
}

export function loadPosConfig(env: NodeJS.ProcessEnv = process.env): PosConfig {
  return {
    port: int(env, 'PORT', 4000),
    rateLimit: int(env, 'POS_RATE_LIMIT', 5),
    rateWindowMs: int(env, 'POS_RATE_WINDOW_MS', 10_000),
    failures: {
      failRate: rate(env, 'FAIL_RATE'),
      timeoutAfterCreateRate: rate(env, 'TIMEOUT_AFTER_CREATE_RATE'),
      slowRate: rate(env, 'SLOW_RATE'),
      timeoutAfterCreateDelayMs: int(env, 'TIMEOUT_AFTER_CREATE_DELAY_MS', 15_000),
      slowMinMs: int(env, 'SLOW_MIN_MS', 3_000),
      slowMaxMs: int(env, 'SLOW_MAX_MS', 8_000),
    },
  };
}

export const POS_CONFIG = Symbol('POS_CONFIG');

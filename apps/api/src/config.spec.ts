import { describe, expect, it } from 'vitest';
import { loadConfig } from './config';

const base = { DATABASE_URL: 'postgres://x/y' };

describe('loadConfig', () => {
  it('applies the documented defaults', () => {
    const config = loadConfig(base);
    expect(config.rateLimit).toEqual({ maxRequests: 5, windowMs: 10_000, safetyMarginMs: 500 });
    expect(config.worker.leaseMs).toBeGreaterThanOrEqual(config.worker.posTimeoutMs + 5_000);
  });

  it('refuses a lease that does not outlive a POS request', () => {
    expect(() => loadConfig({ ...base, POS_TIMEOUT_MS: '10000', SYNC_LEASE_MS: '12000' })).toThrow(
      /SYNC_LEASE_MS/,
    );
  });

  it('refuses a settle window shorter than the POS timeout', () => {
    expect(() => loadConfig({ ...base, POS_TIMEOUT_MS: '10000', SYNC_SETTLE_MS: '5000' })).toThrow(
      /SYNC_SETTLE_MS/,
    );
  });

  it('requires DATABASE_URL', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
  });
});

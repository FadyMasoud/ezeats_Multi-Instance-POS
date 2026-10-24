import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { APP_CONFIG, AppConfig } from '../config';
import { Database, Tx, WORKER_DB } from '../db/database';

export type RateDecision = { allowed: true } | { allowed: false; retryAt: Date };

/**
 * Sliding-window limiter shared by every API instance through Postgres.
 *
 * tryAcquire must run inside the caller's transaction: the token insert commits atomically with
 * the step that will use it (e.g. create_sent_at), and the per-restaurant advisory lock makes the
 * count-then-insert race-free across instances without serializing unrelated restaurants.
 */
@Injectable()
export class PosRateLimiter {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(WORKER_DB) private readonly db: Database,
  ) {}

  private get windowMs(): number {
    return this.config.rateLimit.windowMs + this.config.rateLimit.safetyMarginMs;
  }

  async tryAcquire(tx: Tx, restaurantId: string): Promise<RateDecision> {
    const { maxRequests } = this.config.rateLimit;
    const windowMs = this.windowMs;

    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`pos-rate:${restaurantId}`}, 0))`,
    );

    const blocked = await tx.execute<{ blocked_until: Date }>(sql`
      SELECT blocked_until FROM pos_restaurant_throttle
      WHERE restaurant_id = ${restaurantId} AND blocked_until > clock_timestamp()`);
    const blockedUntil = blocked.rows[0]?.blocked_until;
    if (blockedUntil) return { allowed: false, retryAt: new Date(blockedUntil) };

    const recent = await tx.execute<{ sent_at: Date }>(sql`
      SELECT sent_at FROM pos_rate_events
      WHERE restaurant_id = ${restaurantId}
        AND sent_at > clock_timestamp() - make_interval(secs => ${windowMs / 1000})
      ORDER BY sent_at DESC
      LIMIT ${maxRequests}`);

    if (recent.rows.length < maxRequests) {
      await tx.execute(sql`INSERT INTO pos_rate_events (restaurant_id) VALUES (${restaurantId})`);
      return { allowed: true };
    }

    // The oldest of the last N requests leaves the window first; that is when a slot frees up.
    const oldest = recent.rows[recent.rows.length - 1];
    const retryAt = new Date(new Date(oldest?.sent_at ?? Date.now()).getTime() + windowMs);
    await this.block(tx, restaurantId, retryAt, 'local budget exhausted');
    return { allowed: false, retryAt };
  }

  /** The POS answered 429: back off the whole restaurant on every instance. */
  async markRateLimited(tx: Tx, restaurantId: string, retryAfterMs: number): Promise<Date> {
    // Database clock, so every instance agrees on when the block ends.
    const res = await tx.execute<{ until: Date }>(sql`
      SELECT clock_timestamp() + make_interval(secs => ${Math.max(retryAfterMs, 1_000) / 1000}) AS until`);
    const retryAt = new Date(res.rows[0]?.until ?? Date.now() + retryAfterMs);
    await this.block(tx, restaurantId, retryAt, 'POS returned 429');
    return retryAt;
  }

  private async block(tx: Tx, restaurantId: string, until: Date, reason: string): Promise<void> {
    await tx.execute(sql`
      INSERT INTO pos_restaurant_throttle (restaurant_id, blocked_until, reason, updated_at)
      VALUES (${restaurantId}, ${until.toISOString()}, ${reason}, now())
      ON CONFLICT (restaurant_id) DO UPDATE
        SET blocked_until = GREATEST(pos_restaurant_throttle.blocked_until, EXCLUDED.blocked_until),
            reason = EXCLUDED.reason,
            updated_at = now()`);
  }

  /** Housekeeping: the log only needs the last window. */
  async prune(): Promise<void> {
    await this.db.execute(sql`
      DELETE FROM pos_rate_events WHERE sent_at < clock_timestamp() - interval '5 minutes'`);
    await this.db.execute(sql`
      DELETE FROM pos_restaurant_throttle WHERE blocked_until < clock_timestamp() - interval '5 minutes'`);
  }
}

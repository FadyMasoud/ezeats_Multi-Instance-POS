import {
  BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../config';
import { PosRateLimiter } from './rate-limiter';
import { SyncProcessor } from './sync-processor';

const PRUNE_EVERY_MS = 30_000;

/**
 * Runs inside every API instance. Instances coordinate only through Postgres (leases +
 * SKIP LOCKED), so any number can run and any one can die at any moment.
 */
@Injectable()
export class SyncWorker implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(SyncWorker.name);
  private readonly inFlight = new Set<Promise<void>>();
  private timer: NodeJS.Timeout | null = null;
  private stopping = false;
  private lastPrune = 0;
  private currentCycle: Promise<void> = Promise.resolve();

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly processor: SyncProcessor,
    private readonly rateLimiter: PosRateLimiter,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.worker.enabled) {
      this.logger.log('sync worker disabled');
      return;
    }
    this.logger.log(`sync worker started as ${this.config.instanceId}`);
    this.schedule(0);
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    // A cycle may be mid-claim: wait for it, so the steps it starts are awaited too (the DB
    // pools close right after this hook). Then let in-flight POS calls finish and record their
    // outcome; anything cut off is recovered by another instance once the lease expires.
    await this.currentCycle;
    await this.drain();
  }

  /** Runs one claim/dispatch cycle; exposed for tests that drive the worker deterministically. */
  async tick(): Promise<number> {
    if (this.stopping) return 0;
    const capacity = this.config.worker.maxConcurrency - this.inFlight.size;
    const claims = await this.processor.claimDue(capacity);
    for (const claim of claims) {
      const task = this.processor
        .process(claim)
        .catch((error: unknown) =>
          this.logger.error(`check ${claim.checkId}: step failed`, error as Error),
        )
        .finally(() => this.inFlight.delete(task));
      this.inFlight.add(task);
    }
    return claims.length;
  }

  /** Waits for every step started by tick() to finish. */
  async drain(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.allSettled([...this.inFlight]);
  }

  private schedule(delayMs: number): void {
    if (this.stopping) return;
    this.timer = setTimeout(() => {
      this.currentCycle = this.loop();
    }, delayMs);
  }

  private async loop(): Promise<void> {
    let claimed = 0;
    try {
      claimed = await this.tick();
      if (Date.now() - this.lastPrune > PRUNE_EVERY_MS) {
        this.lastPrune = Date.now();
        await this.rateLimiter.prune();
      }
    } catch (error) {
      this.logger.error('sync worker cycle failed', error as Error);
    }
    // Work was found and there may be more: poll again right away.
    this.schedule(claimed > 0 ? 10 : this.config.worker.pollIntervalMs);
  }
}

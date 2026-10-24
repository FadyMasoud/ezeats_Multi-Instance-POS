import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { asc, eq, getTableColumns, sql } from 'drizzle-orm';
import { DB, Database, Tx } from '../db/database';
import { CheckRow, checkItems, checks, posSync } from '../db/schema';
import { nextAction } from '../sync/sync-machine';
import { snapshotColumns, toSnapshot } from '../sync/sync-processor';
import { CheckResponse, toCheckResponse } from './dto/check-response.dto';
import { CreateCheckDto } from './dto/create-check.dto';

@Injectable()
export class ChecksService {
  constructor(@Inject(DB) private readonly db: Database) {}

  async create(dto: CreateCheckDto): Promise<CheckResponse> {
    return this.db.transaction(async (tx) => {
      const [check] = await tx
        .insert(checks)
        .values({ restaurantId: dto.restaurantId, total: dto.total.toFixed(2) })
        .returning();
      if (!check) throw new Error('insert returned no row');
      const items = await tx
        .insert(checkItems)
        .values(
          dto.items.map((item, position) => ({
            checkId: check.id,
            position,
            name: item.name,
            quantity: item.quantity,
            unitPrice: item.unitPrice.toFixed(2),
          })),
        )
        .returning();
      return toCheckResponse(check, items);
    });
  }

  async get(id: string): Promise<CheckResponse> {
    const [check] = await this.db.select().from(checks).where(eq(checks.id, id));
    if (!check) throw new NotFoundException(`check ${id} not found`);
    return toCheckResponse(check, await this.items(this.db, id));
  }

  /**
   * Marks the check paid and enqueues its POS sync atomically. No POS call happens here, so the
   * response time does not depend on the POS at all. Idempotent for an already-paid check.
   *
   * One statement (a single implicit transaction): the UPDATE only matches an open check, and the
   * outbox INSERT only runs for the row it updated. Three short round trips in total (this
   * statement plus the check and items reads for the response) keep pay fast even when the pool
   * is busy.
   */
  async pay(id: string): Promise<CheckResponse> {
    const paid = await this.db.execute<{ id: string }>(sql`
      WITH paid AS (
        UPDATE checks SET status = 'paid', paid_at = now(), updated_at = now()
        WHERE id = ${id} AND status = 'open'
        RETURNING id, restaurant_id
      ), enqueued AS (
        INSERT INTO pos_sync (check_id, restaurant_id, external_ref)
        SELECT id, restaurant_id, id::text FROM paid
        ON CONFLICT (check_id) DO NOTHING
      )
      SELECT id FROM paid`);

    const check = await this.get(id); // 404 if it does not exist
    if (paid.rows.length === 0 && check.status === 'cancelled') {
      throw new ConflictException({
        code: 'CHECK_CANCELLED',
        message: 'a cancelled check cannot be paid',
      });
    }
    return check;
  }

  /**
   * Cancels an open or paid check. For a paid check the cancel is recorded on the sync row in
   * the same transaction; the worker turns it into POS calls in order (create before cancel).
   * If no create was ever sent and no worker holds the row, the sync is closed right here and
   * the POS is never contacted.
   */
  async cancel(id: string): Promise<CheckResponse> {
    return this.db.transaction(async (tx) => {
      const check = await this.lockCheck(tx, id);
      if (check.status === 'cancelled') return toCheckResponse(check, await this.items(tx, id));

      const [cancelled] = await tx
        .update(checks)
        .set({ status: 'cancelled', cancelledAt: sql`now()`, updatedAt: sql`now()` })
        .where(eq(checks.id, id))
        .returning();
      if (!cancelled) throw new Error('update returned no row');

      if (check.status === 'paid') await this.requestPosCancel(tx, id);
      return toCheckResponse(cancelled, await this.items(tx, id));
    });
  }

  private async requestPosCancel(tx: Tx, checkId: string): Promise<void> {
    const [row] = await tx
      .select({
        ...getTableColumns(posSync),
        leased: sql<boolean>`COALESCE(${posSync.leaseUntil} > now(), false)`,
      })
      .from(posSync)
      .where(eq(posSync.checkId, checkId))
      .for('update');
    if (!row) return;

    if (row.leased) {
      // A worker is mid-step. It re-reads the row under lock when it finishes and will see the
      // flag; touching anything else here could race with its result.
      await tx
        .update(posSync)
        .set({ cancelRequested: true, updatedAt: sql`now()` })
        .where(eq(posSync.checkId, checkId));
      return;
    }

    const snapshot = { ...toSnapshot(row), cancelRequested: true };
    await tx
      .update(posSync)
      .set({
        ...snapshotColumns(snapshot, nextAction(snapshot)),
        // A stopped (failed) sync is resumed: cancelling is an explicit operator/customer intent.
        consecutiveFailures: 0,
        nextAttemptAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .where(eq(posSync.checkId, checkId));
  }

  private async lockCheck(tx: Tx, id: string): Promise<CheckRow> {
    const [check] = await tx.select().from(checks).where(eq(checks.id, id)).for('update');
    if (!check) throw new NotFoundException(`check ${id} not found`);
    return check;
  }

  private items(db: Database | Tx, checkId: string) {
    return db
      .select()
      .from(checkItems)
      .where(eq(checkItems.checkId, checkId))
      .orderBy(asc(checkItems.position));
  }
}

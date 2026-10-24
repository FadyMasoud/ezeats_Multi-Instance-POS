import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { type SQL, and, desc, eq, sql } from 'drizzle-orm';
import { DB, Database } from '../db/database';
import {
  CheckRow,
  PosErrorKind,
  PosSyncAttemptRow,
  PosSyncRow,
  checks,
  posSync,
  posSyncAttempts,
} from '../db/schema';
import { nextAction } from './sync-machine';
import { snapshotColumns, toSnapshot } from './sync-processor';
import {
  SyncStatusDto,
  SyncStatusFilter,
  retryBlockedReason,
  toSyncStatus,
} from './sync-status.dto';

export interface SyncListQuery {
  status?: SyncStatusFilter;
  restaurantId?: string;
  errorKind?: PosErrorKind;
  q?: string;
  page: number;
  pageSize: number;
}

export interface SyncListItem extends SyncStatusDto {
  total: number;
  checkCreatedAt: string;
}

export interface SyncSummary {
  totalChecks: number;
  paidChecks: number;
  cancelledChecks: number;
  synced: number;
  /** Active syncs being processed or waiting without a failure; matches status=in_progress. */
  pending: number;
  /** Active syncs waiting for backoff after a failure; matches status=retrying. Disjoint from pending. */
  retrying: number;
  /** Breakdown of active syncs by state (overlaps pending/retrying). */
  reconciling: number;
  cancellationPending: number;
  failed: number;
  posCancelled: number;
  restaurants: string[];
}

export interface SyncAttemptDto {
  id: number;
  operation: PosSyncAttemptRow['operation'];
  ok: boolean;
  errorKind: PosErrorKind | null;
  httpStatus: number | null;
  message: string | null;
  posOrderId: string | null;
  instanceId: string;
  startedAt: string;
  durationMs: number;
}

const ACTIVE_STATES = sql`('pending', 'reconciling', 'cancelling')`;

@Injectable()
export class SyncService {
  constructor(@Inject(DB) private readonly db: Database) {}

  async getStatus(checkId: string): Promise<SyncStatusDto> {
    const { check, sync } = await this.load(checkId);
    return toSyncStatus(check, sync, new Date());
  }

  /**
   * Re-activates a stopped sync. It only flips durable state; the worker does the POS work and
   * starts from nextAction(), so a create that may already exist is still looked up first.
   */
  async retry(checkId: string): Promise<SyncStatusDto> {
    return this.db.transaction(async (tx) => {
      const [check] = await tx.select().from(checks).where(eq(checks.id, checkId));
      if (!check) throw new NotFoundException(`check ${checkId} not found`);
      const [row] = await tx
        .select()
        .from(posSync)
        .where(eq(posSync.checkId, checkId))
        .for('update');

      const blocked = retryBlockedReason(row ?? null);
      if (!row || blocked) {
        throw new ConflictException({
          code: row ? `SYNC_${row.state.toUpperCase()}` : 'SYNC_NOT_STARTED',
          message: `Manual retry not allowed: ${blocked}`,
          status: toSyncStatus(check, row ?? null, new Date()),
        });
      }

      const snapshot = toSnapshot(row);
      const [updated] = await tx
        .update(posSync)
        .set({
          ...snapshotColumns(snapshot, nextAction(snapshot)),
          consecutiveFailures: 0,
          manualRetryCount: sql`${posSync.manualRetryCount} + 1`,
          nextAttemptAt: sql`now()`,
          updatedAt: sql`now()`,
        })
        .where(eq(posSync.checkId, checkId))
        .returning();
      return toSyncStatus(check, updated ?? row, new Date());
    });
  }

  async list(
    query: SyncListQuery,
  ): Promise<{ items: SyncListItem[]; total: number; page: number; pageSize: number }> {
    const where = and(...this.filters(query));
    const [rows, countRows] = await Promise.all([
      this.db
        .select({ check: checks, sync: posSync })
        .from(checks)
        .leftJoin(posSync, eq(posSync.checkId, checks.id))
        .where(where)
        .orderBy(desc(checks.createdAt), desc(checks.id))
        .limit(query.pageSize)
        .offset((query.page - 1) * query.pageSize),
      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(checks)
        .leftJoin(posSync, eq(posSync.checkId, checks.id))
        .where(where),
    ]);
    const now = new Date();
    return {
      items: rows.map(({ check, sync }) => ({
        ...toSyncStatus(check, sync, now),
        total: Number(check.total),
        checkCreatedAt: check.createdAt.toISOString(),
      })),
      total: countRows[0]?.count ?? 0,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async summary(): Promise<SyncSummary> {
    const result = await this.db.execute<
      Record<keyof Omit<SyncSummary, 'restaurants'>, number>
    >(sql`
      SELECT
        count(*)::int AS "totalChecks",
        (count(*) FILTER (WHERE c.status = 'paid'))::int AS "paidChecks",
        (count(*) FILTER (WHERE c.status = 'cancelled'))::int AS "cancelledChecks",
        (count(*) FILTER (WHERE s.state = 'synced'))::int AS "synced",
        (count(*) FILTER (WHERE s.state IN ${ACTIVE_STATES}
          AND (s.lease_until > now() OR s.consecutive_failures = 0)))::int AS "pending",
        (count(*) FILTER (WHERE s.state IN ${ACTIVE_STATES}
          AND (s.lease_until IS NULL OR s.lease_until <= now()) AND s.consecutive_failures > 0))::int AS "retrying",
        (count(*) FILTER (WHERE s.state = 'reconciling'))::int AS "reconciling",
        (count(*) FILTER (WHERE s.state = 'cancelling'))::int AS "cancellationPending",
        (count(*) FILTER (WHERE s.state = 'failed'))::int AS "failed",
        (count(*) FILTER (WHERE s.state = 'cancelled'))::int AS "posCancelled"
      FROM checks c LEFT JOIN pos_sync s ON s.check_id = c.id`);
    const restaurants = await this.db
      .selectDistinct({ id: checks.restaurantId })
      .from(checks)
      .orderBy(checks.restaurantId)
      .limit(500);
    const counts = result.rows[0];
    if (!counts) throw new Error('summary query returned no row');
    return { ...counts, restaurants: restaurants.map((r) => r.id) };
  }

  async attempts(checkId: string): Promise<SyncAttemptDto[]> {
    const rows = await this.db
      .select()
      .from(posSyncAttempts)
      .where(eq(posSyncAttempts.checkId, checkId))
      .orderBy(desc(posSyncAttempts.startedAt), desc(posSyncAttempts.id))
      .limit(200);
    return rows.map((r) => ({
      id: r.id,
      operation: r.operation,
      ok: r.ok,
      errorKind: r.errorKind,
      httpStatus: r.httpStatus,
      message: r.message,
      posOrderId: r.posOrderId,
      instanceId: r.instanceId,
      startedAt: r.startedAt.toISOString(),
      durationMs: r.finishedAt.getTime() - r.startedAt.getTime(),
    }));
  }

  private async load(checkId: string): Promise<{ check: CheckRow; sync: PosSyncRow | null }> {
    const [row] = await this.db
      .select({ check: checks, sync: posSync })
      .from(checks)
      .leftJoin(posSync, eq(posSync.checkId, checks.id))
      .where(eq(checks.id, checkId));
    if (!row) throw new NotFoundException(`check ${checkId} not found`);
    return row;
  }

  private filters(query: SyncListQuery): SQL[] {
    const filters: SQL[] = [];
    if (query.restaurantId) filters.push(eq(checks.restaurantId, query.restaurantId));
    if (query.errorKind) filters.push(eq(posSync.lastErrorKind, query.errorKind));
    if (query.q) filters.push(sql`${checks.id}::text ILIKE ${`${query.q.trim()}%`}`);
    const status = statusFilter(query.status);
    if (status) filters.push(status);
    return filters;
  }
}

const LEASED = sql`(${posSync.leaseUntil} IS NOT NULL AND ${posSync.leaseUntil} > now())`;
const ACTIVE = sql`${posSync.state} IN ${ACTIVE_STATES}`;
/** SQL twin of displayStatusOf(): same precedence (processing, then retrying, then state). */
const IDLE_NO_FAILURE = sql`NOT ${LEASED} AND ${posSync.consecutiveFailures} = 0`;

function statusFilter(status: SyncStatusFilter | undefined): SQL | null {
  switch (status) {
    case undefined:
      return null;
    case 'awaiting_payment':
      return sql`${posSync.checkId} IS NULL AND ${checks.status} = 'open'`;
    case 'not_required':
      return sql`${posSync.checkId} IS NULL AND ${checks.status} = 'cancelled'`;
    case 'in_progress':
      return sql`${ACTIVE} AND (${LEASED} OR ${posSync.consecutiveFailures} = 0)`;
    case 'processing':
      return sql`${ACTIVE} AND ${LEASED}`;
    case 'retrying':
      return sql`${ACTIVE} AND NOT ${LEASED} AND ${posSync.consecutiveFailures} > 0`;
    case 'pending':
      return sql`${posSync.state} = 'pending' AND ${IDLE_NO_FAILURE}`;
    case 'reconciling':
      return sql`${posSync.state} = 'reconciling' AND ${IDLE_NO_FAILURE}`;
    case 'cancellation_pending':
      return sql`${posSync.state} = 'cancelling' AND ${IDLE_NO_FAILURE}`;
    case 'synced':
    case 'cancelled':
    case 'failed':
      return eq(posSync.state, status);
  }
}

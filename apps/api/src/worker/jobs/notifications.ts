import type pg from "pg";
import type { JobDefinition } from "../runner.js";
import {
  BENCH_TIME_SCHEDULE, NOTIFICATION_PRUNE_SCHEDULE, dueMaintenanceKeys, dueReminderKey, type DailySchedule,
} from "../schedule.js";

/**
 * Scheduled notification jobs (design B6; migration 0046). Detection jobs only
 * write outbox events (through definer functions, deduplicated by
 * eureka.notification_ledger); the outbox-delivery job notifies.
 *
 * Built here: bench-time (FR-NTF-05) over candidate.bench_since. The other
 * reminders (visa expiry, paperwork/documents overdue, project exit, team
 * assigned, assignment ending soon) are emitted by the modules that own their
 * data; docs/notifications.md lists their event shapes.
 */
export const BENCH_TIME_JOB = "bench-time";
export const NOTIFICATION_PRUNE_JOB = "notification-prune";

const DELETE_BATCH = 1000;

/**
 * FR-NTF-05: once a candidate has been on bench for `thresholdDays` (OD-05,
 * still open: the job is off until NOTIFY_BENCH_DAYS is set), one
 * `employee.benched` event per bench period. Run key = the New York date the
 * reminder runs for (never a future day; the database refuses one).
 */
export function benchTimeJob(thresholdDays: number, schedule: DailySchedule = BENCH_TIME_SCHEDULE): JobDefinition {
  if (!Number.isInteger(thresholdDays) || thresholdDays < 1 || thresholdDays > 365) {
    throw new Error("bench threshold must be 1 to 365 days");
  }
  return {
    name: BENCH_TIME_JOB,
    dueKeys: (now) => [dueReminderKey(now, schedule)],
    async run(day, { pool }) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error("bench-time run key must be a date");
      const r = await pool.query<{ n: number }>("SELECT authz.emit_bench_time($1::date, $2) AS n", [day, thresholdDays]);
      return { emitted: r.rows[0]!.n, thresholdDays };
    },
  };
}

/** Deletes inbox rows older than `retentionDays` (the database refuses fewer than 30). */
export async function pruneNotifications(
  pool: pg.Pool, retentionDays: number, ctx: { signal: AbortSignal; heartbeat?: () => void },
): Promise<number> {
  if (!Number.isInteger(retentionDays) || retentionDays < 30) throw new Error("notification retention must be at least 30 days");
  let total = 0;
  for (;;) {
    ctx.signal.throwIfAborted();
    const r = await pool.query(
      `DELETE FROM eureka.notification WHERE id IN (
         SELECT id FROM eureka.notification
          WHERE created_at < now() - make_interval(days => $1) ORDER BY created_at LIMIT ${DELETE_BATCH})`,
      [retentionDays]);
    total += r.rowCount ?? 0;
    ctx.heartbeat?.();
    if ((r.rowCount ?? 0) < DELETE_BATCH) return total;
  }
}

export function notificationPruneJob(retentionDays: number): JobDefinition {
  return {
    name: NOTIFICATION_PRUNE_JOB,
    dueKeys: (now) => dueMaintenanceKeys(now, NOTIFICATION_PRUNE_SCHEDULE),
    async run(_key, ctx) { return { deleted: await pruneNotifications(ctx.pool, retentionDays, ctx), retentionDays }; },
  };
}

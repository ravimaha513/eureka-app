import type pg from "pg";
import type { JobContext, JobDefinition } from "../runner.js";
import { dueMaintenanceKeys, utcDateKey, type DailySchedule } from "../schedule.js";

/**
 * Retention jobs (migration 0518; docs/notifications.md "Retention"). Each one
 * calls narrow SECURITY DEFINER functions executable by eureka_worker only (the
 * worker has no grants on the identity tables); the database enforces the
 * minimum retention and deletes a bounded batch per call, so the jobs loop.
 * Only counts reach job_run and the log.
 *
 * - session-retention (daily 05:15 New York): staff sessions that ended
 *   (expired or revoked) more than SESSION_RETENTION_DAYS ago, with their
 *   step-up rows (FK cascade); step-up challenges and grants of still-live
 *   sessions expired more than STEP_UP_RETENTION_DAYS ago; applicant (portal)
 *   sessions that ended more than SESSION_RETENTION_DAYS ago, verified
 *   applicants included. The floor (30 days) keeps the Settings login-activity
 *   view (LOGIN_ACTIVITY_DAYS = 30) complete.
 * - audit-retention (daily 05:30 New York, after the 03:30 export): OFF unless
 *   AUDIT_RETENTION_DAYS is set (default: audit_event is kept for ever). When
 *   on, deletes audit rows older than that many days (at least 365) whose UTC
 *   day has an audit_export ledger row covering their seq (the S3 export
 *   succeeded). The database refuses anything else, whoever calls.
 * - rate-limit-purge (hourly): calls authz.rate_purge() when that function
 *   exists (shared rate limiter, migrations 0516/0517); until then it records
 *   `available: false` and does nothing.
 */
export const SESSION_RETENTION_JOB = "session-retention";
export const AUDIT_RETENTION_JOB = "audit-retention";
export const RATE_LIMIT_PURGE_JOB = "rate-limit-purge";
export const SESSION_RETENTION_SCHEDULE: DailySchedule = { hh: 5, mm: 15, timeZone: "America/New_York" };
export const AUDIT_RETENTION_SCHEDULE: DailySchedule = { hh: 5, mm: 30, timeZone: "America/New_York" };

export const DEFAULT_SESSION_RETENTION_DAYS = 30;
export const DEFAULT_STEP_UP_RETENTION_DAYS = 7;
/** Rows per definer call (the functions' own LIMIT); fewer means done. */
const SESSION_BATCH = 1000;
/** eureka.prune_step_up deletes up to 500 challenges and 500 grants per call. */
const STEP_UP_BATCH = 500;
const AUDIT_BATCH = 5000;
const MAX_ROUNDS = 200;

/** Calls `SELECT <fn>($1) AS n` until a call deletes fewer than `batch` rows. */
async function loop(ctx: JobContext, sql: string, params: unknown[], batch: number): Promise<number> {
  let total = 0;
  for (let i = 0; i < MAX_ROUNDS; i++) {
    ctx.signal.throwIfAborted();
    const n = (await ctx.pool.query<{ n: number }>(sql, params)).rows[0]!.n;
    total += n;
    ctx.heartbeat();
    if (n < batch) break;
  }
  return total;
}

export interface SessionRetentionOptions { sessionDays: number; stepUpDays: number }

export function sessionRetentionJob(
  o: SessionRetentionOptions = { sessionDays: DEFAULT_SESSION_RETENTION_DAYS, stepUpDays: DEFAULT_STEP_UP_RETENTION_DAYS },
  schedule: DailySchedule = SESSION_RETENTION_SCHEDULE,
): JobDefinition {
  if (!Number.isInteger(o.sessionDays) || o.sessionDays < 30 || o.sessionDays > 3650) throw new Error("session retention days must be 30 to 3650");
  if (!Number.isInteger(o.stepUpDays) || o.stepUpDays < 1 || o.stepUpDays > 365) throw new Error("step-up retention days must be 1 to 365");
  return {
    name: SESSION_RETENTION_JOB,
    dueKeys: (now) => dueMaintenanceKeys(now, schedule),
    async run(_key, ctx) {
      const sessions = await loop(ctx, "SELECT eureka.prune_staff_sessions($1) AS n", [o.sessionDays], SESSION_BATCH);
      const stepUp = await loop(ctx, "SELECT eureka.prune_step_up($1) AS n", [o.stepUpDays], STEP_UP_BATCH);
      const applicantSessions = await loop(ctx, "SELECT authz.prune_applicant_sessions($1) AS n", [o.sessionDays], SESSION_BATCH);
      return { sessions, stepUp, applicantSessions, sessionDays: o.sessionDays, stepUpDays: o.stepUpDays };
    },
  };
}

/** Only scheduled when AUDIT_RETENTION_DAYS is set (see worker.ts); refuses fewer than 365 days. */
export function auditRetentionJob(days: number, schedule: DailySchedule = AUDIT_RETENTION_SCHEDULE): JobDefinition {
  if (!Number.isInteger(days) || days < 365 || days > 36500) throw new Error("audit retention days must be 365 to 36500");
  return {
    name: AUDIT_RETENTION_JOB,
    dueKeys: (now) => dueMaintenanceKeys(now, schedule),
    async run(_key, ctx) {
      return { deleted: await loop(ctx, "SELECT eureka.audit_prune_exported($1) AS n", [days], AUDIT_BATCH), days };
    },
  };
}

/** True once the shared limiter's purge function is installed (migrations 0516/0517, another branch). */
export async function ratePurgeAvailable(pool: pg.Pool): Promise<boolean> {
  const r = await pool.query<{ ok: boolean }>("SELECT to_regprocedure('authz.rate_purge()') IS NOT NULL AS ok");
  return r.rows[0]!.ok;
}

/** Hourly: run key = the UTC hour ("YYYY-MM-DDTHH"), the previous hour once a few minutes into the next. */
export function rateLimitPurgeJob(): JobDefinition {
  return {
    name: RATE_LIMIT_PURGE_JOB,
    dueKeys(now) {
      const hour = new Date(now.getTime() - 5 * 60_000);
      return [`${utcDateKey(hour)}T${String(hour.getUTCHours()).padStart(2, "0")}`];
    },
    async run(_key, ctx) {
      if (!(await ratePurgeAvailable(ctx.pool))) return { available: false };
      // Return type belongs to the limiter's migration: report a count when it is one.
      const r = await ctx.pool.query<{ n: unknown }>("SELECT authz.rate_purge() AS n");
      const n = r.rows[0]?.n;
      return { available: true, ...(typeof n === "number" || typeof n === "string" ? { deleted: Number(n) } : {}) };
    },
  };
}

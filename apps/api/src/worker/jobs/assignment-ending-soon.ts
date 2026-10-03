import type { JobDefinition } from "../runner.js";
import { dueMaintenanceKeys, type DailySchedule } from "../schedule.js";

/**
 * assignment-ending-soon (FR-EMP, migration 0045, docs/employees-api.md):
 * daily, records one `assignment.ending_soon` outbox row per open assignment
 * whose planned end date is within `days` days, once per planned end date
 * (a changed date re-arms it). Only outbox rows: delivery belongs to the
 * notification jobs. Runs authz.assignment_ending_soon_scan (definer, worker
 * only), which writes at most 1000 rows per call; the job calls it until a
 * call writes fewer.
 */
export const ASSIGNMENT_ENDING_SOON_JOB = "assignment-ending-soon";
export const ASSIGNMENT_ENDING_SOON_SCHEDULE: DailySchedule = { hh: 5, mm: 0, timeZone: "America/New_York" };
/** Notice window in days (a default until the product owner sets it; the database accepts 1..90). */
export const ASSIGNMENT_ENDING_SOON_DAYS = 30;
const SCAN_BATCH = 1000;
const MAX_CALLS = 50;

export function assignmentEndingSoonJob(days = ASSIGNMENT_ENDING_SOON_DAYS): JobDefinition {
  return {
    name: ASSIGNMENT_ENDING_SOON_JOB,
    dueKeys: (now) => dueMaintenanceKeys(now, ASSIGNMENT_ENDING_SOON_SCHEDULE),
    async run(_key, ctx) {
      let events = 0;
      for (let i = 0; i < MAX_CALLS && !ctx.signal.aborted; i++) {
        const n = (await ctx.pool.query<{ n: number }>(`SELECT authz.assignment_ending_soon_scan($1) AS n`, [days])).rows[0]!.n;
        events += n;
        ctx.heartbeat();
        if (n < SCAN_BATCH) break;
      }
      return { events, days };
    },
  };
}

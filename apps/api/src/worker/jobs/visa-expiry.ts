import type { JobDefinition } from "../runner.js";
import { VISA_EXPIRY_SCHEDULE, dueMaintenanceKeys } from "../schedule.js";

/**
 * visa-expiry (design B6; FR-VIS-03, FR-NTF-11; migration 0042). Daily after
 * 06:00 America/New_York. authz.work_auth_expiry_notices inserts one
 * `work_authorization.expiring` outbox event per valid work authorization,
 * threshold and expiry date (the smallest threshold reached; see the function
 * and docs/work-authorization-api.md for the event shape). "Today" is the
 * database's New York calendar day, so the run key is only a label; a missed
 * day is caught up by the next run. Delivery (email, in-app inbox) is done by
 * the notification jobs, not here.
 */
export const VISA_EXPIRY_JOB = "visa-expiry";

export function visaExpiryJob(thresholdDays: readonly number[]): JobDefinition {
  return {
    name: VISA_EXPIRY_JOB,
    dueKeys: (now) => dueMaintenanceKeys(now, VISA_EXPIRY_SCHEDULE),
    async run(_key, { pool }) {
      const events = (await pool.query<{ n: number }>(
        `SELECT authz.work_auth_expiry_notices($1::integer[]) AS n`, [thresholdDays])).rows[0]!.n;
      return { events, thresholdDays: [...thresholdDays] };
    },
  };
}

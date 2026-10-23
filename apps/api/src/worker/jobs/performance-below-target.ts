import type { JobDefinition } from "../runner.js";
import { dueReminderKey, type DailySchedule } from "../schedule.js";

/**
 * performance-below-target (docs/performance-api.md PF-6, docs/notifications.md
 * `performance.below_target`; migration 0112). Daily after 07:15
 * America/New_York, before the US working day. For every recruiter target whose
 * period ended within the last `windowDays` days, authz.emit_performance_below_target
 * compares the person's own activity in the period with the target and writes
 * one outbox event when any metric fell short, exactly once per target (the
 * notification ledger). Run key = the New York date; the database refuses a
 * future day. Delivery (email + inbox to the person, their team lead and the
 * lead's manager) is the outbox-delivery job's.
 */
export const PERFORMANCE_BELOW_TARGET_JOB = "performance-below-target";
export const PERFORMANCE_BELOW_TARGET_SCHEDULE: DailySchedule = { hh: 7, mm: 15, timeZone: "America/New_York" };
/** Periods that ended longer ago than this are not reported (a first enable must not flood the inboxes). */
export const PERFORMANCE_BELOW_TARGET_WINDOW_DAYS = 14;

export function performanceBelowTargetJob(
  schedule: DailySchedule = PERFORMANCE_BELOW_TARGET_SCHEDULE,
  windowDays: number = PERFORMANCE_BELOW_TARGET_WINDOW_DAYS,
): JobDefinition {
  return {
    name: PERFORMANCE_BELOW_TARGET_JOB,
    dueKeys: (now) => [dueReminderKey(now, schedule)],
    async run(day, { pool }) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error("performance-below-target run key must be a date");
      const r = await pool.query<{ n: number }>("SELECT authz.emit_performance_below_target($1::date, $2::int) AS n", [day, windowDays]);
      return { emitted: r.rows[0]!.n };
    },
  };
}

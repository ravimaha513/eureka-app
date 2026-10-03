import type { JobDefinition } from "../runner.js";
import { PAPERWORK_OVERDUE_SCHEDULE, dueReminderKey, type DailySchedule } from "../schedule.js";

/**
 * paperwork-overdue (FR-NTF-04 / FR-NTF-03; migrations 0044 and 0052). Daily
 * after 07:30 America/New_York. authz.emit_paperwork_overdue writes one
 * `checklist.item_overdue` outbox event per outstanding checklist item past its
 * due date (exactly once per item and due date, through the notification
 * ledger; a new due date re-arms it). Run key = the New York date the reminder
 * runs for; the database refuses a future day. Delivery (email + inbox) is the
 * outbox-delivery job's.
 */
export const PAPERWORK_OVERDUE_JOB = "paperwork-overdue";

export function paperworkOverdueJob(schedule: DailySchedule = PAPERWORK_OVERDUE_SCHEDULE): JobDefinition {
  return {
    name: PAPERWORK_OVERDUE_JOB,
    dueKeys: (now) => [dueReminderKey(now, schedule)],
    async run(day, { pool }) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error("paperwork-overdue run key must be a date");
      const r = await pool.query<{ n: number }>("SELECT authz.emit_paperwork_overdue($1::date) AS n", [day]);
      return { emitted: r.rows[0]!.n };
    },
  };
}

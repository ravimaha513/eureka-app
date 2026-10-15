import type { JobDefinition } from "../runner.js";
import { BIRTHDAY_DIGEST_SCHEDULE, dueReminderKey, type DailySchedule } from "../schedule.js";

/**
 * birthday-digest (interview-alerts package, migration 0087). Daily after
 * 08:00 America/New_York. authz.emit_birthdays writes one
 * `staff.birthdays_today` outbox event for the day when at least one active
 * staff member has a birthday (once per day through the notification ledger;
 * 29 February is celebrated on 28 February in other years). Run key = the New
 * York date; the database refuses a future day. Delivery (email + inbox to the
 * CEO, names read at send time) is the outbox-delivery job's.
 */
export const BIRTHDAY_DIGEST_JOB = "birthday-digest";

export function birthdayDigestJob(schedule: DailySchedule = BIRTHDAY_DIGEST_SCHEDULE): JobDefinition {
  return {
    name: BIRTHDAY_DIGEST_JOB,
    dueKeys: (now) => [dueReminderKey(now, schedule)],
    async run(day, { pool }) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error("birthday-digest run key must be a date");
      const r = await pool.query<{ n: number }>("SELECT authz.emit_birthdays($1::date) AS n", [day]);
      return { emitted: r.rows[0]!.n };
    },
  };
}

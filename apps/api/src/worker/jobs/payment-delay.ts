import type { JobDefinition } from "../runner.js";
import { dueReminderKey, type DailySchedule } from "../schedule.js";

/**
 * payment-delay (FR-PAY-06 / FR-NTF-08; migration 0100, docs/payments-api.md).
 * Daily after 07:15 America/New_York. authz.emit_payment_delays writes one
 * `payment.delayed` outbox event per live invoice past its expected payment
 * date and not fully received (exactly once per invoice and expected date,
 * through the notification ledger; a changed invoice date or terms re-arms it).
 * Run key = the New York date the scan runs for; the database refuses a future
 * day. Delivery (email + inbox to the recruiter and team lead) is the
 * outbox-delivery job's.
 */
export const PAYMENT_DELAY_JOB = "payment-delay";
export const PAYMENT_DELAY_SCHEDULE: DailySchedule = { hh: 7, mm: 15, timeZone: "America/New_York" };

export function paymentDelayJob(schedule: DailySchedule = PAYMENT_DELAY_SCHEDULE): JobDefinition {
  return {
    name: PAYMENT_DELAY_JOB,
    dueKeys: (now) => [dueReminderKey(now, schedule)],
    async run(day, { pool }) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error("payment-delay run key must be a date");
      const r = await pool.query<{ n: number }>("SELECT authz.emit_payment_delays($1::date) AS n", [day]);
      return { emitted: r.rows[0]!.n };
    },
  };
}

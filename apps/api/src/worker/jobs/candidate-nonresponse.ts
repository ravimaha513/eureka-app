import type { MailTransport } from "../feedback-mail.js";
import type { JobDefinition } from "../runner.js";
import { dueReminderKey, type DailySchedule } from "../schedule.js";

/**
 * "Candidate not responding" (migration 0171, docs/notifications.md
 * `candidate.not_responding`, docs/pipeline-vendors-api.md PV-7, PV-8).
 *
 * candidate-nonresponse: daily after 07:40 America/New_York. Flags still open
 * `holdDays` after Sales raised them reach the hold stage once
 * (authz.emit_candidate_nonresponse_hold): a second staff event and the
 * candidate's final notice. Run key = the New York date (never a future day).
 *
 * candidate-nonresponse-mail: every tick, one run key per due email
 * ("<flag id>:<stage>"). The candidate's address is read inside the send
 * transaction under a row lock on the flag, so a flag resolved meanwhile is
 * never mailed. Fixed text only: no recruiter, client or reason.
 */
export const CANDIDATE_NONRESPONSE_JOB = "candidate-nonresponse";
export const CANDIDATE_NONRESPONSE_MAIL_JOB = "candidate-nonresponse-mail";
export const CANDIDATE_NONRESPONSE_SCHEDULE: DailySchedule = { hh: 7, mm: 40, timeZone: "America/New_York" };
export const DEFAULT_NONRESPONSE_HOLD_DAYS = 3;

function checkHoldDays(holdDays: number) {
  if (!Number.isInteger(holdDays) || holdDays < 1 || holdDays > 60) throw new Error("non-response hold delay must be 1 to 60 days");
}

export function candidateNonresponseJob(
  holdDays = DEFAULT_NONRESPONSE_HOLD_DAYS, schedule: DailySchedule = CANDIDATE_NONRESPONSE_SCHEDULE,
): JobDefinition {
  checkHoldDays(holdDays);
  return {
    name: CANDIDATE_NONRESPONSE_JOB,
    dueKeys: (now) => [dueReminderKey(now, schedule)],
    async run(day, { pool }) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error("candidate-nonresponse run key must be a date");
      const r = await pool.query<{ n: number }>("SELECT authz.emit_candidate_nonresponse_hold($1::date, $2) AS n", [day, holdDays]);
      return { emitted: r.rows[0]!.n };
    },
  };
}

/** The candidate-facing email of a stage (fixed text, no personal data beyond the address it goes to). */
export function nonresponseMail(stage: "warning" | "hold", holdDays: number): { subject: string; text: string } {
  const days = `${holdDays} day${holdDays === 1 ? "" : "s"}`;
  return stage === "warning"
    ? {
      subject: "Please get in touch with your recruiter",
      text: "We have been trying to reach you about your marketing and have not heard back.\n"
        + `Please reply to your recruiter within ${days}. If we do not hear from you, your marketing will be put on hold.\n`,
    }
    : {
      subject: "Final notice: your marketing will be put on hold",
      text: "We still have not been able to reach you about your marketing.\n"
        + "Your recruiter may now put your marketing on hold or stop it. Please contact your recruiter as soon as possible to continue.\n",
    };
}

const KEY = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):(warning|hold)$/i;

export function candidateNonresponseMailJob(mail: MailTransport, holdDays = DEFAULT_NONRESPONSE_HOLD_DAYS): JobDefinition {
  checkHoldDays(holdDays);
  return {
    name: CANDIDATE_NONRESPONSE_MAIL_JOB,
    async dueKeys(_now, { pool }) {
      return (await pool.query<{ k: string }>("SELECT k FROM authz.nonresponse_mail_due()")).rows.map((r) => r.k);
    },
    async run(key, { pool, signal }) {
      const m = KEY.exec(key);
      if (!m) throw new Error("candidate-nonresponse-mail run key must be <flag id>:<stage>");
      const flagId = m[1]!;
      // KEY is case-insensitive: normalise the stage and refuse anything but the two stages the mail knows.
      const stage = m[2]!.toLowerCase();
      if (stage !== "warning" && stage !== "hold") throw new Error("candidate-nonresponse-mail stage must be warning or hold");
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        const { rows } = await c.query<{ email: string }>("SELECT email FROM authz.nonresponse_mail_data($1, $2)", [flagId, stage]);
        if (rows[0]) {
          signal.throwIfAborted();
          const content = nonresponseMail(stage, holdDays);
          await mail.send({ id: `nonresponse-${flagId}-${stage}`, to: rows[0].email, ...content }, signal);
          await c.query("SELECT authz.nonresponse_mail_sent($1, $2)", [flagId, stage]);
        }
        await c.query("COMMIT");
        return { delivered: rows.length > 0, stage };
      } catch {
        await c.query("ROLLBACK").catch(() => undefined);
        // Never pass on provider errors: they can contain the recipient.
        throw new Error("Candidate non-response email failed; retry pending");
      } finally { c.release(); }
    },
  };
}

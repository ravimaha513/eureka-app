import { createHash, randomBytes } from "node:crypto";
import { decryptToken, encryptToken, type MailTransport } from "../feedback-mail.js";
import type { JobDefinition } from "../runner.js";

export function feedbackEmailJob(mail: MailTransport, origin: string, key: string): JobDefinition {
  return {
    name: "feedback-email",
    async dueKeys(_now, { pool }) {
      // Preparing in its own transaction preserves the encrypted token before
      // any provider call. A crash after delivery retries the identical link.
      const due = await pool.query<{ id: string }>("SELECT * FROM eureka.feedback_due()");
      const keys: string[] = [];
      for (const row of due.rows) {
        const token = randomBytes(32).toString("base64url");
        const prepared = await pool.query<{ id: string | null }>("SELECT eureka.feedback_prepare($1,$2,$3) AS id", [row.id,
          createHash("sha256").update(token).digest("hex"), encryptToken(token, key)]);
        if (prepared.rows[0]?.id) keys.push(prepared.rows[0].id);
      }
      return keys;
    },
    async run(id, { pool, signal }) {
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        // Row lock serializes cancellation/reschedule and delivery; recheck after
        // claiming the lease. Network call has a hard timeout and honors abort.
        const { rows } = await c.query<{ email: string; cipher: string }>("SELECT * FROM eureka.feedback_send_data($1)", [id]);
        if (!rows[0]) throw new Error("Delivery no longer eligible");
        if (rows[0]) {
          signal.throwIfAborted();
          const token = decryptToken(rows[0].cipher, key);
          await mail.send({ id, to: rows[0].email, subject: "Your interview feedback",
            text: `Please share feedback about your interview: ${origin}/feedback/${token}\nThis link expires 48 hours after creation and can be submitted once.` }, signal);
          await c.query("SELECT eureka.feedback_sent($1)", [id]);
        }
        await c.query("COMMIT");
        return { delivered: rows.length > 0 };
      } catch {
        await c.query("ROLLBACK").catch(() => undefined);
        throw new Error("Feedback delivery failed; retry pending");
      } finally { c.release(); }
    },
  };
}
export function feedbackNotificationJob(mail: MailTransport, origin: string): JobDefinition {
  return {
    name: "feedback-notification",
    async dueKeys(_now, { pool }) { return (await pool.query<{ id: string }>("SELECT * FROM eureka.feedback_notification_due()")).rows.map((r) => r.id); },
    async run(id, { pool, signal }) {
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        const { rows } = await c.query<{ email: string }>("SELECT * FROM eureka.feedback_notification_data($1)", [id]);
        if (rows[0]) await mail.send({ id, to: rows[0].email, subject: "Candidate interview feedback received",
          text: `New candidate feedback is available. Sign in to the interview board to review it: ${origin}` }, signal);
        await c.query("SELECT eureka.feedback_notification_sent($1)", [id]);
        await c.query("COMMIT");
        return { delivered: rows.length > 0 };
      } catch {
        await c.query("ROLLBACK").catch(() => undefined);
        throw new Error("Feedback notification failed; retry pending");
      } finally { c.release(); }
    },
  };
}

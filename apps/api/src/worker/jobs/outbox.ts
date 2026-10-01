import type pg from "pg";
import { MailRejected, type MailTransport } from "../feedback-mail.js";
import type { Logger } from "../log.js";
import type { JobDefinition } from "../runner.js";
import { IDEMPOTENCY_CLEANUP_SCHEDULE, OUTBOX_PRUNE_SCHEDULE, dueMaintenanceKeys } from "../schedule.js";

/**
 * Outbox delivery (design A7, PL-7; migration 0024). Each unpublished
 * `placement.created` / `placement.state_changed` event is one job_run key
 * (its id), so the runner's lease, backoff and alerting apply per event.
 *
 * Delivery of one event:
 *  1. Fan-out (once, in one transaction with the event row locked): one
 *     outbox_delivery row per distinct active user holding a role of the
 *     event's recipient groups. A user in several groups gets one email.
 *     Rows left in `sending` by an earlier run that died are marked in_doubt.
 *  2. Per recipient: re-check the user is still active and still holds the
 *     role (else `skipped`), mark `sending` (committed), send, mark `sent`.
 *     A MailRejected error (provider definitely refused) puts the row back to
 *     `pending` and the run fails, so the runner retries after backoff. Any
 *     other error leaves the outcome unknown: the row becomes `in_doubt`.
 *  3. When every row is final, the event is marked published.
 *
 * Guarantee: an email is never sent twice to the same recipient for the same
 * event. A crash (or lost database connection) between the provider accepting
 * the message and the `sent` update leaves the row in `sending`; the next run
 * marks it in_doubt and does not resend (at most once per recipient, with an
 * alert log). Everything before the `sending` mark is retried (at least once
 * up to that point).
 *
 * Emails carry no personal data: the event, the placement status, the
 * placement reference (an id) and a sign-in link. Addresses are read at send
 * time and never stored, logged or written to job_run.
 */
export const OUTBOX_DELIVERY_JOB = "outbox-delivery";
export const OUTBOX_PRUNE_JOB = "outbox-prune";
export const IDEMPOTENCY_CLEANUP_JOB = "idempotency-cleanup";

/** Recipient groups named in an event's `notify` list -> role keys. */
export const RECIPIENT_GROUPS = {
  hr: ["hr"],
  accounts: ["accounts"],
  immigration: ["immigration"],
} as const satisfies Record<string, readonly string[]>;
type Group = keyof typeof RECIPIENT_GROUPS;
const GROUP_LABELS: Record<Group, string> = { hr: "HR", accounts: "Accounts", immigration: "Immigration" };

export const DELIVERED_TYPES = ["placement.created", "placement.state_changed"] as const;
type EventType = (typeof DELIVERED_TYPES)[number];

const STATUS_LABELS: Record<string, string> = {
  confirmed: "Confirmed", paperwork: "Paperwork", bgc: "Background check", ready: "Ready to join",
  joined: "Joined", backout: "Backed out", bgc_failed: "Background check failed",
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DELETE_BATCH = 1000;

interface OutboxEvent { id: string; type: EventType; aggregate_id: string; payload: Record<string, unknown> }

function statusLabel(v: unknown): string {
  if (typeof v !== "string" || !(v in STATUS_LABELS)) throw new Error("outbox event has an unknown status");
  return STATUS_LABELS[v]!;
}

/** The event's recipient groups; an event naming none (or only unknown ones) is invalid. */
export function recipientGroups(payload: Record<string, unknown>): Group[] {
  const notify = payload.notify;
  if (!Array.isArray(notify)) throw new Error("outbox event has no notify list");
  const groups = [...new Set(notify.filter((g): g is Group => typeof g === "string" && g in RECIPIENT_GROUPS))];
  if (groups.length === 0) throw new Error("outbox event names no known recipient group");
  return groups.sort();
}

export function rolesOf(groups: Group[]): string[] {
  return [...new Set(groups.flatMap((g) => RECIPIENT_GROUPS[g]))].sort();
}

/** Subject and body for one recipient. Only states, the placement id and the link. */
export function renderEmail(ev: OutboxEvent, origin: string, recipientGroups: Group[]): { subject: string; text: string } {
  const ref = ev.aggregate_id;
  if (!UUID.test(ref)) throw new Error("outbox event has an invalid aggregate id");
  const why = `You receive this email as a member of ${recipientGroups.map((g) => GROUP_LABELS[g]).join(" and ")}.`;
  const footer = `Placement reference: ${ref}\n\nSign in to Eureka for the details: ${origin}/\n${why}\n`;
  if (ev.type === "placement.created") {
    return {
      subject: "Eureka: new placement",
      text: `A new placement was recorded in Eureka (status: ${statusLabel(ev.payload.status)}).\n${footer}`,
    };
  }
  const from = statusLabel(ev.payload.from);
  const to = statusLabel(ev.payload.to);
  return {
    subject: `Eureka: placement status changed to ${to}`,
    text: `A placement in Eureka moved from ${from} to ${to}.\n${footer}`,
  };
}

/**
 * Locks the unpublished event, marks interrupted sends in_doubt and, the first
 * time, records the recipients. Returns null when the event is already published.
 */
async function prepare(pool: pg.Pool, id: string, log: Logger): Promise<{ ev: OutboxEvent; groups: Group[] } | null> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const r = await c.query<OutboxEvent>(
      `SELECT id, type, aggregate_id, payload FROM eureka.outbox_event
        WHERE id = $1 AND published_at IS NULL FOR UPDATE`, [id]);
    const ev = r.rows[0];
    if (!ev) { await c.query("COMMIT"); return null; }
    if (!(DELIVERED_TYPES as readonly string[]).includes(ev.type)) throw new Error("outbox event type is not delivered");
    const groups = recipientGroups(ev.payload);

    const doubt = await c.query(
      `UPDATE eureka.outbox_delivery SET status = 'in_doubt' WHERE event_id = $1 AND status = 'sending'`, [id]);
    if (doubt.rowCount) {
      log.error("outbox delivery interrupted after the send started; not resent", {
        job: OUTBOX_DELIVERY_JOB, eventId: id, inDoubt: doubt.rowCount, alert: true });
    }

    const any = await c.query("SELECT 1 FROM eureka.outbox_delivery WHERE event_id = $1 LIMIT 1", [id]);
    if (!any.rowCount) {
      await c.query(
        `INSERT INTO eureka.outbox_delivery (event_id, user_id)
         SELECT DISTINCT $1::uuid, u.id
           FROM eureka.app_user u JOIN eureka.user_role ur ON ur.user_id = u.id
          WHERE u.status = 'active' AND ur.role_key = ANY ($2::text[]) AND ur.valid @> now()`,
        [id, rolesOf(groups)]);
    }
    await c.query("COMMIT");
    return { ev, groups };
  } catch (err) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    c.release();
  }
}

export interface DeliveryResult {
  /** The event was already published before this run (nothing done). */
  alreadyPublished: boolean;
  recipients: number;
  sent: number;
  skipped: number;
  inDoubt: number;
}

/** Delivers one event (see the module comment). Throws when a retry is needed. */
export async function deliverEvent(
  pool: pg.Pool, mail: MailTransport, origin: string, id: string,
  ctx: { log: Logger; signal: AbortSignal; heartbeat?: () => void },
): Promise<DeliveryResult> {
  const prepared = await prepare(pool, id, ctx.log);
  if (!prepared) return { alreadyPublished: true, recipients: 0, sent: 0, skipped: 0, inDoubt: 0 };
  const { ev, groups } = prepared;
  const roles = rolesOf(groups);
  renderEmail(ev, origin, groups); // a malformed event fails before anyone is emailed

  const pending = await pool.query<{ user_id: string }>(
    `SELECT user_id FROM eureka.outbox_delivery WHERE event_id = $1 AND status = 'pending' ORDER BY user_id`, [id]);
  let rejected = 0;
  for (const { user_id: userId } of pending.rows) {
    ctx.signal.throwIfAborted();
    ctx.heartbeat?.();
    // Still active and still in a recipient group? Which groups (for the email)?
    const who = await pool.query<{ email: string; roles: string[] }>(
      `SELECT u.email::text AS email, array_agg(DISTINCT ur.role_key) AS roles
         FROM eureka.app_user u JOIN eureka.user_role ur ON ur.user_id = u.id
        WHERE u.id = $1 AND u.status = 'active' AND ur.role_key = ANY ($2::text[]) AND ur.valid @> now()
        GROUP BY u.email`, [userId, roles]);
    const recipient = who.rows[0];
    if (!recipient) {
      await pool.query(
        `UPDATE eureka.outbox_delivery SET status = 'skipped' WHERE event_id = $1 AND user_id = $2 AND status = 'pending'`,
        [id, userId]);
      continue;
    }
    const mine = groups.filter((g) => RECIPIENT_GROUPS[g].some((r) => recipient.roles.includes(r)));
    const { subject, text } = renderEmail(ev, origin, mine);

    // The dedupe marker: committed before the provider call.
    const claimed = await pool.query(
      `UPDATE eureka.outbox_delivery SET status = 'sending' WHERE event_id = $1 AND user_id = $2 AND status = 'pending'`,
      [id, userId]);
    if (claimed.rowCount !== 1) continue;
    let outcome: "sent" | "pending" | "in_doubt";
    try {
      await mail.send({ id: `${id}-${userId}`, to: recipient.email, subject, text }, ctx.signal);
      outcome = "sent";
    } catch (err) {
      outcome = err instanceof MailRejected ? "pending" : "in_doubt";
    }
    // If this update is lost (crash, database gone), the row stays `sending`
    // and the next run marks it in_doubt: never a second email.
    await pool.query(
      `UPDATE eureka.outbox_delivery SET status = $3 WHERE event_id = $1 AND user_id = $2 AND status = 'sending'`,
      [id, userId, outcome]);
    if (outcome === "pending") rejected++;
    if (outcome === "in_doubt") {
      ctx.log.error("outbox email outcome unknown; not resent", {
        job: OUTBOX_DELIVERY_JOB, eventId: id, userId, alert: true });
    }
  }
  if (rejected > 0) throw new Error(`${rejected} outbox email(s) rejected by the provider; retry pending`);

  const counts = await pool.query<{ status: string; n: number }>(
    `SELECT status, count(*)::int AS n FROM eureka.outbox_delivery WHERE event_id = $1 GROUP BY status`, [id]);
  const n = (s: string) => counts.rows.find((r) => r.status === s)?.n ?? 0;
  if (n("pending") + n("sending") > 0) throw new Error("outbox deliveries still open; retry pending");
  const recipients = counts.rows.reduce((a, r) => a + r.n, 0);
  if (recipients === 0) ctx.log.warn("outbox event has no recipients", { job: OUTBOX_DELIVERY_JOB, eventId: id, groups });

  await pool.query("UPDATE eureka.outbox_event SET published_at = now() WHERE id = $1 AND published_at IS NULL", [id]);
  return { alreadyPublished: false, recipients, sent: n("sent"), skipped: n("skipped"), inDoubt: n("in_doubt") };
}

/** Unpublished deliverable events, oldest first, skipping events waiting in backoff. */
export async function dueOutboxEvents(pool: pg.Pool, batchSize: number): Promise<string[]> {
  const r = await pool.query<{ id: string }>(
    `SELECT e.id FROM eureka.outbox_event e
      WHERE e.published_at IS NULL AND e.type = ANY ($1::text[])
        AND NOT EXISTS (SELECT 1 FROM eureka.job_run j
                         WHERE j.job_name = $2 AND j.run_key = e.id::text
                           AND (j.next_attempt_at > now() OR (j.status = 'running' AND j.lease_until > now())))
      ORDER BY e.created_at, e.id LIMIT $3`, [DELIVERED_TYPES, OUTBOX_DELIVERY_JOB, batchSize]);
  return r.rows.map((x) => x.id);
}

export function outboxDeliveryJob(mail: MailTransport, origin: string, batchSize: number): JobDefinition {
  return {
    name: OUTBOX_DELIVERY_JOB,
    dueKeys: (_now, { pool }) => dueOutboxEvents(pool, batchSize),
    async run(id, ctx) {
      const r = await deliverEvent(ctx.pool, mail, origin, id, ctx);
      return { ...r };
    },
  };
}

/** Deletes in batches until none is left (short statements; abortable). */
async function deleteInBatches(
  pool: pg.Pool, sql: string, params: unknown[], ctx: { signal: AbortSignal; heartbeat?: () => void },
): Promise<number> {
  let total = 0;
  for (;;) {
    ctx.signal.throwIfAborted();
    const r = await pool.query(sql, params);
    total += r.rowCount ?? 0;
    ctx.heartbeat?.();
    if ((r.rowCount ?? 0) < DELETE_BATCH) return total;
  }
}

/** Deletes outbox events published more than `retentionDays` ago (their delivery rows cascade). */
export async function pruneOutbox(pool: pg.Pool, retentionDays: number, ctx: { signal: AbortSignal; heartbeat?: () => void }) {
  if (!Number.isInteger(retentionDays) || retentionDays < 7) throw new Error("outbox retention must be at least 7 days");
  return deleteInBatches(pool,
    `DELETE FROM eureka.outbox_event WHERE id IN (
       SELECT id FROM eureka.outbox_event
        WHERE published_at < now() - make_interval(days => $1) ORDER BY published_at LIMIT ${DELETE_BATCH})`,
    [retentionDays], ctx);
}

/** Deletes Idempotency-Key rows older than 24 hours. */
export function cleanupIdempotencyKeys(pool: pg.Pool, ctx: { signal: AbortSignal; heartbeat?: () => void }) {
  return deleteInBatches(pool,
    `DELETE FROM eureka.idempotency_key WHERE (user_id, endpoint, key) IN (
       SELECT user_id, endpoint, key FROM eureka.idempotency_key
        WHERE created_at < now() - interval '24 hours' ORDER BY created_at LIMIT ${DELETE_BATCH})`,
    [], ctx);
}

export function outboxPruneJob(retentionDays: number): JobDefinition {
  return {
    name: OUTBOX_PRUNE_JOB,
    dueKeys: (now) => dueMaintenanceKeys(now, OUTBOX_PRUNE_SCHEDULE),
    async run(_key, ctx) { return { deleted: await pruneOutbox(ctx.pool, retentionDays, ctx), retentionDays }; },
  };
}

export function idempotencyCleanupJob(): JobDefinition {
  return {
    name: IDEMPOTENCY_CLEANUP_JOB,
    dueKeys: (now) => dueMaintenanceKeys(now, IDEMPOTENCY_CLEANUP_SCHEDULE),
    async run(_key, ctx) { return { deleted: await cleanupIdempotencyKeys(ctx.pool, ctx) }; },
  };
}

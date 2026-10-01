import type pg from "pg";
import { MailRejected, type MailTransport } from "../feedback-mail.js";
import type { Logger } from "../log.js";
import { DEFAULT_RUNNER_OPTIONS, type JobDefinition } from "../runner.js";
import { IDEMPOTENCY_CLEANUP_SCHEDULE, OUTBOX_PRUNE_SCHEDULE, dueMaintenanceKeys } from "../schedule.js";

/**
 * Outbox delivery (design A7, PL-7; migrations 0024, 0029). Each unpublished
 * `placement.created` / `placement.state_changed` event is one job_run key
 * (its id), so the runner's lease, backoff and alerting apply per event.
 *
 * Delivery of one event:
 *  1. Fan-out (once, in one transaction with the event row locked): one
 *     outbox_delivery row per distinct active user holding a role of the
 *     event's recipient groups. A user in several groups gets one email.
 *     No recipient at all: the event stays unpublished, alert, retry.
 *     Rows left in `sending` for longer than the lease window by an earlier
 *     run that died are marked in_doubt (younger ones may belong to a live
 *     runner: left alone, this run fails and retries).
 *  2. Per recipient: re-check the user is still active and still holds the
 *     role (else `skipped`), mark `sending` (committed), send, mark `sent`.
 *     A MailRejected error (provider definitely refused) puts the row back to
 *     `pending` and the run fails, so the runner retries after backoff;
 *     throttling is not counted, other rejections are, and after
 *     maxRejections the row is `failed` (final, alert). Any other error
 *     leaves the outcome unknown: the row becomes `in_doubt`. A final update
 *     that matches no row (taken over meanwhile) is logged as an alert.
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
async function prepare(
  pool: pg.Pool, id: string, log: Logger, staleSendingMs: number,
): Promise<{ ev: OutboxEvent; groups: Group[] } | null> {
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

    // Only sends older than the lease window: a younger `sending` row may
    // belong to a runner that is still alive (lease takeover); it is left
    // alone and this run fails and retries later.
    const doubt = await c.query(
      `UPDATE eureka.outbox_delivery SET status = 'in_doubt'
        WHERE event_id = $1 AND status = 'sending' AND attempt_at < now() - $2 * interval '1 millisecond'`,
      [id, staleSendingMs]);
    if (doubt.rowCount) {
      log.error("outbox delivery interrupted after the send started; not resent", {
        job: OUTBOX_DELIVERY_JOB, eventId: id, inDoubt: doubt.rowCount, alert: true });
    }

    const any = await c.query("SELECT 1 FROM eureka.outbox_delivery WHERE event_id = $1 LIMIT 1", [id]);
    if (!any.rowCount) {
      const added = await c.query(
        `INSERT INTO eureka.outbox_delivery (event_id, user_id)
         SELECT DISTINCT $1::uuid, u.id
           FROM eureka.app_user u JOIN eureka.user_role ur ON ur.user_id = u.id
          WHERE u.status = 'active' AND ur.role_key = ANY ($2::text[]) AND ur.valid @> now()`,
        [id, rolesOf(groups)]);
      if (!added.rowCount) {
        // Nobody holds a recipient role: keep the event unpublished and retry
        // (backoff) until someone does, rather than dropping the notification.
        log.error("outbox event has no recipients; kept unpublished", {
          job: OUTBOX_DELIVERY_JOB, eventId: id, groups, alert: true });
        throw new Error("outbox event has no recipients; retry pending");
      }
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
  failed: number;
}

export interface DeliveryOptions {
  /** Definite (non-throttling) rejections after which a recipient is `failed`. */
  maxRejections: number;
  /** A `sending` row older than this (the runner lease) is in doubt. */
  staleSendingMs: number;
}
export const DEFAULT_DELIVERY_OPTIONS: DeliveryOptions = { maxRejections: 5, staleSendingMs: DEFAULT_RUNNER_OPTIONS.leaseMs };

/** Delivers one event (see the module comment). Throws when a retry is needed. */
export async function deliverEvent(
  pool: pg.Pool, mail: MailTransport, origin: string, id: string,
  ctx: { log: Logger; signal: AbortSignal; heartbeat?: () => void },
  options: Partial<DeliveryOptions> = {},
): Promise<DeliveryResult> {
  const opts = { ...DEFAULT_DELIVERY_OPTIONS, ...options };
  const prepared = await prepare(pool, id, ctx.log, opts.staleSendingMs);
  if (!prepared) return { alreadyPublished: true, recipients: 0, sent: 0, skipped: 0, inDoubt: 0, failed: 0 };
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
    const claimed = await pool.query<{ rejections: number }>(
      `UPDATE eureka.outbox_delivery SET status = 'sending' WHERE event_id = $1 AND user_id = $2 AND status = 'pending'
       RETURNING rejections`, [id, userId]);
    if (claimed.rowCount !== 1) continue; // another runner took it
    let outcome: "sent" | "pending" | "in_doubt" | "failed";
    let counted = 0;
    try {
      await mail.send({ id: `${id}-${userId}`, to: recipient.email, subject, text }, ctx.signal);
      outcome = "sent";
    } catch (err) {
      if (!(err instanceof MailRejected)) outcome = "in_doubt";
      else if (err.throttled) outcome = "pending";
      else {
        counted = 1;
        outcome = claimed.rows[0]!.rejections + 1 >= opts.maxRejections ? "failed" : "pending";
      }
    }
    // If this update is lost (crash, database gone), the row stays `sending`
    // and a later run marks it in_doubt: never a second email.
    const done = await pool.query(
      `UPDATE eureka.outbox_delivery SET status = $3, rejections = rejections + $4
        WHERE event_id = $1 AND user_id = $2 AND status = 'sending'`,
      [id, userId, outcome, counted]);
    if (done.rowCount !== 1) {
      ctx.log.error("outbox delivery row changed during the send (lease taken over?); outcome not recorded", {
        job: OUTBOX_DELIVERY_JOB, eventId: id, userId, outcome, alert: true });
      continue;
    }
    if (outcome === "pending") rejected++;
    if (outcome === "in_doubt") {
      ctx.log.error("outbox email outcome unknown; not resent", {
        job: OUTBOX_DELIVERY_JOB, eventId: id, userId, alert: true });
    }
    if (outcome === "failed") {
      ctx.log.error("outbox email rejected repeatedly; given up", {
        job: OUTBOX_DELIVERY_JOB, eventId: id, userId, rejections: opts.maxRejections, alert: true });
    }
  }
  if (rejected > 0) throw new Error(`${rejected} outbox email(s) rejected or throttled by the provider; retry pending`);

  const counts = await pool.query<{ status: string; n: number }>(
    `SELECT status, count(*)::int AS n FROM eureka.outbox_delivery WHERE event_id = $1 GROUP BY status`, [id]);
  const n = (s: string) => counts.rows.find((r) => r.status === s)?.n ?? 0;
  if (n("pending") + n("sending") > 0) throw new Error("outbox deliveries still open; retry pending");
  const recipients = counts.rows.reduce((a, r) => a + r.n, 0);
  if (recipients === 0) throw new Error("outbox event has no recipients; retry pending");

  await pool.query("UPDATE eureka.outbox_event SET published_at = now() WHERE id = $1 AND published_at IS NULL", [id]);
  return { alreadyPublished: false, recipients, sent: n("sent"), skipped: n("skipped"), inDoubt: n("in_doubt"), failed: n("failed") };
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

/**
 * Backlog cut-off (OUTBOX_DELIVER_SINCE): unpublished events created before
 * `since` are marked published without sending, so enabling delivery on a
 * database with old events does not email them all. Returns the count.
 */
export async function skipBacklog(pool: pg.Pool, since: Date, log: Logger): Promise<number> {
  const r = await pool.query(
    `UPDATE eureka.outbox_event SET published_at = now()
      WHERE published_at IS NULL AND created_at < $1 AND type = ANY ($2::text[])`, [since, DELIVERED_TYPES]);
  const skipped = r.rowCount ?? 0;
  if (skipped > 0) {
    log.warn("outbox events before OUTBOX_DELIVER_SINCE marked published without sending", {
      job: OUTBOX_DELIVERY_JOB, skipped, since: since.toISOString() });
  }
  return skipped;
}

export interface OutboxDeliveryJobOptions extends Partial<DeliveryOptions> {
  batchSize: number;
  /** Events created before this are never emailed (see skipBacklog). */
  deliverSince?: Date;
}

export function outboxDeliveryJob(mail: MailTransport, origin: string, o: OutboxDeliveryJobOptions): JobDefinition {
  return {
    name: OUTBOX_DELIVERY_JOB,
    async dueKeys(_now, { pool, log }) {
      if (o.deliverSince) await skipBacklog(pool, o.deliverSince, log);
      return dueOutboxEvents(pool, o.batchSize);
    },
    async run(id, ctx) {
      const r = await deliverEvent(ctx.pool, mail, origin, id, ctx, o);
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

/**
 * Deletes succeeded outbox-delivery job_run rows (one per event) finished more
 * than `retentionDays` ago, through eureka.prune_outbox_job_runs (migration
 * 0029; the worker has no DELETE on job_run).
 */
export async function pruneOutboxJobRuns(pool: pg.Pool, retentionDays: number, ctx: { signal: AbortSignal; heartbeat?: () => void }) {
  let total = 0;
  for (;;) {
    ctx.signal.throwIfAborted();
    const n = (await pool.query<{ n: number }>("SELECT eureka.prune_outbox_job_runs($1) AS n", [retentionDays])).rows[0]!.n;
    total += n;
    ctx.heartbeat?.();
    if (n < 5000) return total;
  }
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
    async run(_key, ctx) {
      const deleted = await pruneOutbox(ctx.pool, retentionDays, ctx);
      return { deleted, jobRunsDeleted: await pruneOutboxJobRuns(ctx.pool, retentionDays, ctx), retentionDays };
    },
  };
}

export function idempotencyCleanupJob(): JobDefinition {
  return {
    name: IDEMPOTENCY_CLEANUP_JOB,
    dueKeys: (now) => dueMaintenanceKeys(now, IDEMPOTENCY_CLEANUP_SCHEDULE),
    async run(_key, ctx) { return { deleted: await cleanupIdempotencyKeys(ctx.pool, ctx) }; },
  };
}

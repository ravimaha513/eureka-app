import type pg from "pg";
import { MANDATORY_NOTIFICATION_TYPES } from "@eureka/shared";
import { MailRejected, type MailTransport } from "../feedback-mail.js";
import type { Logger } from "../log.js";
import { DEFAULT_RUNNER_OPTIONS, type JobDefinition } from "../runner.js";
import { IDEMPOTENCY_CLEANUP_SCHEDULE, OUTBOX_PRUNE_SCHEDULE, dueMaintenanceKeys } from "../schedule.js";
import { DELIVERED_TYPES, EMAIL_TYPES, INBOX_TYPES, renderEmail, specOf, type EventSpec, type OutboxEvent } from "../notify-types.js";

/**
 * Outbox delivery (design A7, B6, PL-7; migrations 0024, 0029, 0046). Each
 * unpublished event of a delivered type (worker/notify-types.ts,
 * docs/notifications.md) is one job_run key (its id), so the runner's lease,
 * backoff and alerting apply per event. A type has an email channel, an in-app
 * (inbox) channel or both; recipients come from the database
 * (authz.notification_recipients, by type), never from the client.
 *
 * Delivery of one event:
 *  1. Fan-out (in one transaction with the event row locked):
 *     - inbox: the first time, one notification row per recipient and the
 *       inbox_fanout marker, together (exactly once; the database refuses
 *       rows for an event whose marker exists);
 *     - email: the first time, one outbox_delivery row per recipient. A user
 *       with several reasons (roles, recruiter and lead...) gets one email.
 *     No recipient at all: the event stays unpublished, alert, retry.
 *     Rows left in `sending` for longer than the lease window by an earlier
 *     run that died are marked in_doubt (younger ones may belong to a live
 *     runner: left alone, this run fails and retries).
 *     An in-app-only event is published in the same transaction.
 *  2. Per email recipient: re-check that the user is still a recipient
 *     (active, still holds the role or the relation) else `skipped`; mark
 *     `sending` (committed), send, mark `sent`. A MailRejected error
 *     (provider definitely refused) puts the row back to `pending` and the run
 *     fails, so the runner retries after backoff; throttling is not counted,
 *     other rejections are, and after maxRejections the row is `failed`
 *     (final, alert). Any other error leaves the outcome unknown: the row
 *     becomes `in_doubt`. A final update that matches no row (taken over
 *     meanwhile) is logged as an alert.
 *  3. When every email row is final, the event is marked published.
 *
 * Without a mail transport (OUTBOX_MAIL_MODE=disabled) the job still runs the
 * inbox channel: in-app-only events are delivered and published; events that
 * also email get their inbox rows under the run key `inbox:<id>` and stay
 * unpublished (so they are not pruned) until a mail mode is set, exactly as
 * email-only events do.
 *
 * Guarantee: an email is never sent twice to the same recipient for the same
 * event. A crash (or lost database connection) between the provider accepting
 * the message and the `sent` update leaves the row in `sending`; the next run
 * marks it in_doubt and does not resend (at most once per recipient, with an
 * alert log). Everything before the `sending` mark is retried (at least once
 * up to that point). Inbox rows are written exactly once per recipient.
 *
 * Emails and inbox rows carry no personal data (see notify-types.ts).
 * Addresses are read at send time and never stored, logged or written to job_run.
 */
export { DELIVERED_TYPES };
export const OUTBOX_DELIVERY_JOB = "outbox-delivery";
export const OUTBOX_PRUNE_JOB = "outbox-prune";
export const IDEMPOTENCY_CLEANUP_JOB = "idempotency-cleanup";
/** Run-key prefix of an inbox-only run (mail disabled, type also emails). */
export const INBOX_KEY_PREFIX = "inbox:";

const DELETE_BATCH = 1000;

/** "inbox" runs only the in-app channel; "full" runs every channel of the type. */
export type DeliveryMode = "full" | "inbox";

interface Prepared { ev: OutboxEvent; spec: EventSpec; inApp: number | undefined; published: boolean; cutOff: boolean }

/**
 * Locks the unpublished event, marks interrupted sends in_doubt and, the first
 * time per channel, records the recipients. Returns null when the event is
 * already published.
 */
async function prepare(
  pool: pg.Pool, id: string, log: Logger, staleSendingMs: number, withEmail: boolean, deliverSince?: Date,
): Promise<Prepared | null> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const r = await c.query<OutboxEvent & { created_at: Date }>(
      `SELECT id, type, aggregate_id, payload, created_at FROM eureka.outbox_event
        WHERE id = $1 AND published_at IS NULL FOR UPDATE`, [id]);
    const row = r.rows[0];
    if (!row) { await c.query("COMMIT"); return null; }
    const { created_at: createdAt, ...ev } = row;
    const spec = specOf(ev.type);
    const rendered = spec.render(ev); // a malformed event fails before anyone is notified
    // Backlog cut-off (OUTBOX_DELIVER_SINCE) for an emailing type: an event
    // created before it is never emailed. Its inbox part is still delivered
    // (in-app, exactly once) and it is published without delivery rows. An
    // event whose emails had already started keeps going (rows exist).
    let cutOff = false;
    if (spec.email && withEmail && deliverSince && createdAt < deliverSince) {
      const started = await c.query("SELECT 1 FROM eureka.outbox_delivery WHERE event_id = $1 LIMIT 1", [id]);
      cutOff = !started.rowCount;
    }
    const email = spec.email && withEmail && !cutOff;

    if (email) {
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
    }

    let recipients: string[] | null = null;
    const resolve = async (): Promise<string[]> => {
      recipients ??= (await c.query<{ recipient_id: string }>(
        `SELECT DISTINCT recipient_id FROM authz.notification_recipients($1) ORDER BY recipient_id`, [id]))
        .rows.map((x) => x.recipient_id);
      if (recipients.length === 0) {
        // Nobody qualifies: keep the event unpublished and retry (backoff)
        // until someone does, rather than dropping the notification.
        log.error("outbox event has no recipients; kept unpublished", {
          job: OUTBOX_DELIVERY_JOB, eventId: id, type: ev.type, alert: true });
        throw new Error("outbox event has no recipients; retry pending");
      }
      return recipients;
    };

    let inApp: number | undefined;
    if (spec.inApp) {
      const done = await c.query<{ recipients: number }>("SELECT recipients FROM eureka.inbox_fanout WHERE event_id = $1", [id]);
      if (done.rows[0]) inApp = done.rows[0].recipients;
      else {
        const users = await resolve();
        const box = rendered.inbox!;
        // Users who switched this type off in Settings get no inbox row (migration 0081);
        // mandatory types cannot be switched off. The marker counts every resolved recipient.
        const muted = MANDATORY_NOTIFICATION_TYPES.includes(ev.type) ? [] : (await c.query<{ user_id: string }>(
          `SELECT user_id FROM eureka.notification_preference WHERE type = $1 AND NOT in_app AND user_id = ANY ($2::uuid[])`,
          [ev.type, users])).rows.map((r) => r.user_id);
        const inbox = users.filter((u) => !muted.includes(u));
        await c.query(
          `INSERT INTO eureka.notification (recipient_id, event_id, type, entity_type, entity_id, title, body)
           SELECT u, $2, $3, $4, $5, $6, $7 FROM unnest($1::uuid[]) AS u`,
          [inbox, id, ev.type, box.entity.type, box.entity.id, box.title, box.body]);
        await c.query("INSERT INTO eureka.inbox_fanout (event_id, recipients) VALUES ($1, $2)", [id, users.length]);
        inApp = inbox.length;
      }
    }

    if (email) {
      const any = await c.query("SELECT 1 FROM eureka.outbox_delivery WHERE event_id = $1 LIMIT 1", [id]);
      if (!any.rowCount) {
        await c.query(
          `INSERT INTO eureka.outbox_delivery (event_id, user_id) SELECT $1, u FROM unnest($2::uuid[]) AS u`,
          [id, await resolve()]);
      }
    }

    let published = false;
    if (!spec.email || cutOff) {
      await c.query("UPDATE eureka.outbox_event SET published_at = now() WHERE id = $1 AND published_at IS NULL", [id]);
      published = true;
    }
    await c.query("COMMIT");
    if (cutOff) {
      log.warn("outbox event before OUTBOX_DELIVER_SINCE published without email", {
        job: OUTBOX_DELIVERY_JOB, eventId: id, type: ev.type, inApp: inApp ?? 0 });
    }
    return { ev, spec, inApp, published, cutOff };
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
  /** Inbox rows of the event (in-app types only). */
  inApp?: number;
  /** An inbox-only run of a type that also emails: the email part is still to come. */
  emailPending?: boolean;
  /** Created before OUTBOX_DELIVER_SINCE: published without email. */
  emailCutOff?: boolean;
}

export interface DeliveryOptions {
  /** Definite (non-throttling) rejections after which a recipient is `failed`. */
  maxRejections: number;
  /** A `sending` row older than this (the runner lease) is in doubt. */
  staleSendingMs: number;
  mode: DeliveryMode;
  /** Backlog cut-off (OUTBOX_DELIVER_SINCE): emailing events created before it are not emailed. */
  deliverSince?: Date;
}
export const DEFAULT_DELIVERY_OPTIONS: DeliveryOptions = {
  maxRejections: 5, staleSendingMs: DEFAULT_RUNNER_OPTIONS.leaseMs, mode: "full",
};

/** Delivers one event (see the module comment). Throws when a retry is needed. */
export async function deliverEvent(
  pool: pg.Pool, mail: MailTransport | null, origin: string | null, id: string,
  ctx: { log: Logger; signal: AbortSignal; heartbeat?: () => void },
  options: Partial<DeliveryOptions> = {},
): Promise<DeliveryResult> {
  const opts = { ...DEFAULT_DELIVERY_OPTIONS, ...options };
  const withEmail = opts.mode === "full";
  const prepared = await prepare(pool, id, ctx.log, opts.staleSendingMs, withEmail && mail !== null, opts.deliverSince);
  if (!prepared) return { alreadyPublished: true, recipients: 0, sent: 0, skipped: 0, inDoubt: 0, failed: 0 };
  const { ev, spec, inApp } = prepared;
  const extra = inApp === undefined ? {} : { inApp };
  if (prepared.cutOff) {
    return { alreadyPublished: false, recipients: inApp ?? 0, sent: 0, skipped: 0, inDoubt: 0, failed: 0, ...extra, emailCutOff: true };
  }
  if (!spec.email) {
    return { alreadyPublished: false, recipients: inApp ?? 0, sent: 0, skipped: 0, inDoubt: 0, failed: 0, ...extra };
  }
  if (!withEmail) {
    return { alreadyPublished: false, recipients: inApp ?? 0, sent: 0, skipped: 0, inDoubt: 0, failed: 0, ...extra, emailPending: true };
  }
  // A full run of an emailing type needs a transport: never record success without the email part.
  if (!mail || !origin) throw new Error("email delivery is not configured; retry pending");

  const pending = await pool.query<{ user_id: string }>(
    `SELECT user_id FROM eureka.outbox_delivery WHERE event_id = $1 AND status = 'pending' ORDER BY user_id`, [id]);
  let rejected = 0;
  for (const { user_id: userId } of pending.rows) {
    ctx.signal.throwIfAborted();
    ctx.heartbeat?.();
    // Still a recipient (active, role or relation still holds)? For which reasons (for the email)?
    const who = await pool.query<{ email: string; reasons: string[] }>(
      `SELECT u.email::text AS email, array_agg(DISTINCT r.reason ORDER BY r.reason) AS reasons
         FROM authz.notification_recipients($1, $2) r JOIN eureka.app_user u ON u.id = r.recipient_id
        WHERE u.status = 'active'
        GROUP BY u.email`, [id, userId]);
    const recipient = who.rows[0];
    if (!recipient) {
      await pool.query(
        `UPDATE eureka.outbox_delivery SET status = 'skipped' WHERE event_id = $1 AND user_id = $2 AND status = 'pending'`,
        [id, userId]);
      continue;
    }
    const { subject, text } = renderEmail(ev, origin, recipient.reasons);

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
  return { alreadyPublished: false, recipients, sent: n("sent"), skipped: n("skipped"), inDoubt: n("in_doubt"), failed: n("failed"), ...extra };
}

/**
 * Run keys of unpublished deliverable events, oldest first, skipping keys
 * waiting in backoff or under a live lease. With mail: every delivered type
 * (key = event id). Without mail: in-app-only types (key = event id) and,
 * for types that also email, the inbox part once (key = `inbox:<id>`, until
 * the inbox_fanout marker exists); email-only events wait.
 */
export async function dueOutboxEvents(pool: pg.Pool, batchSize: number, mailEnabled = true): Promise<string[]> {
  const r = await pool.query<{ key: string }>(
    `SELECT k.key FROM (
       SELECT e.created_at, e.id,
              CASE WHEN $4 OR NOT (e.type = ANY ($5::text[])) THEN e.id::text ELSE $6 || e.id::text END AS key
         FROM eureka.outbox_event e
        WHERE e.published_at IS NULL AND e.type = ANY ($1::text[])
          AND ($4 OR NOT (e.type = ANY ($5::text[]))
               OR (e.type = ANY ($7::text[]) AND NOT EXISTS (SELECT 1 FROM eureka.inbox_fanout f WHERE f.event_id = e.id)))
     ) k
      WHERE NOT EXISTS (SELECT 1 FROM eureka.job_run j
                         WHERE j.job_name = $2 AND j.run_key = k.key
                           AND (j.next_attempt_at > now() OR (j.status = 'running' AND j.lease_until > now())))
      ORDER BY k.created_at, k.id LIMIT $3`,
    [DELIVERED_TYPES, OUTBOX_DELIVERY_JOB, batchSize, mailEnabled, EMAIL_TYPES, INBOX_KEY_PREFIX, INBOX_TYPES]);
  return r.rows.map((x) => x.key);
}

/**
 * Backlog cut-off (OUTBOX_DELIVER_SINCE): unpublished emailing events created
 * before `since` are marked published without sending, so enabling delivery on
 * a database with old events does not email them all. An event that also has
 * an inbox part is cut off only once its inbox rows exist. Returns the count.
 */
export async function skipBacklog(pool: pg.Pool, since: Date, log: Logger): Promise<number> {
  const r = await pool.query(
    `UPDATE eureka.outbox_event e SET published_at = now()
      WHERE e.published_at IS NULL AND e.created_at < $1 AND e.type = ANY ($2::text[])
        AND (NOT (e.type = ANY ($3::text[])) OR EXISTS (SELECT 1 FROM eureka.inbox_fanout f WHERE f.event_id = e.id))`,
    [since, EMAIL_TYPES, INBOX_TYPES]);
  const skipped = r.rowCount ?? 0;
  if (skipped > 0) {
    log.warn("outbox events before OUTBOX_DELIVER_SINCE marked published without sending", {
      job: OUTBOX_DELIVERY_JOB, skipped, since: since.toISOString() });
  }
  return skipped;
}

export interface OutboxDeliveryJobOptions extends Partial<Omit<DeliveryOptions, "mode">> {
  batchSize: number;
  /** Events created before this are never emailed (see skipBacklog; only with mail). */
  deliverSince?: Date;
}

/**
 * The delivery job. `mail` and `origin` null (OUTBOX_MAIL_MODE=disabled): the
 * inbox channel only (see dueOutboxEvents).
 */
export function outboxDeliveryJob(mail: MailTransport | null, origin: string | null, o: OutboxDeliveryJobOptions): JobDefinition {
  const mailEnabled = mail !== null && origin !== null;
  return {
    name: OUTBOX_DELIVERY_JOB,
    async dueKeys(_now, { pool, log }) {
      if (mailEnabled && o.deliverSince) await skipBacklog(pool, o.deliverSince, log);
      return dueOutboxEvents(pool, o.batchSize, mailEnabled);
    },
    async run(key, ctx) {
      const inbox = key.startsWith(INBOX_KEY_PREFIX);
      const id = inbox ? key.slice(INBOX_KEY_PREFIX.length) : key;
      const r = await deliverEvent(ctx.pool, mailEnabled ? mail : null, mailEnabled ? origin : null, id, ctx,
        { ...o, mode: inbox ? "inbox" : "full" });
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

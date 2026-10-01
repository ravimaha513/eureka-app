import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadWorkerConfig } from "../src/worker/config.js";
import { MailRejected, type Mail, type MailTransport } from "../src/worker/feedback-mail.js";
import {
  cleanupIdempotencyKeys, deliverEvent, dueOutboxEvents, idempotencyCleanupJob, outboxDeliveryJob, outboxPruneJob, pruneOutbox,
  pruneOutboxJobRuns,
} from "../src/worker/jobs/outbox.js";
import { createLogger, silentLogger } from "../src/worker/log.js";
import { JobRunner } from "../src/worker/runner.js";
import { asUser, createTestDb, type TestDb } from "./db-harness.js";
import { LOC, T, U, seedFixtures } from "./fixtures.js";
import { createPlacement, newCandidate, selectedSubmission, transitionPlacement } from "./placement-seed.js";

/** Outbox delivery, pruning and idempotency-key cleanup (migrations 0024, 0029; worker jobs). */
let db: TestDb;
const ORIGIN = "https://eureka.example";
const extra: Record<string, string> = {};

class FakeMail implements MailTransport {
  sent: Mail[] = [];
  constructor(private readonly fail: (m: Mail) => Error | null = () => null) {}
  async send(m: Mail) {
    const err = this.fail(m);
    if (err) throw err;
    this.sent.push(m);
  }
  to() { return this.sent.map((m) => m.to).sort(); }
}

const ctx = () => ({ log: silentLogger, signal: new AbortController().signal, heartbeat() {} });

/** Superuser write with triggers off (time travel in test setup only). */
async function force(sql: string, params: unknown[] = []) {
  const c = await db.admin.connect();
  try {
    await c.query("BEGIN");
    await c.query("SET LOCAL session_replication_role = replica");
    await c.query(sql, params);
    await c.query("COMMIT");
  } finally {
    c.release();
  }
}

async function denied(pool: pg.Pool, sql: string, params: unknown[] = []): Promise<string> {
  try {
    await pool.query(sql, params);
  } catch (err) {
    return (err as Error).message;
  }
  return "allowed";
}

/** A new placement by r1a; returns the placement id and its outbox event id. */
async function newPlacement() {
  const cand = await newCandidate(db, { teamId: T.t1, recruiterId: U.r1a, locationId: LOC.dallas });
  const sub = await selectedSubmission(db, U.r1a, cand.id);
  const p = await createPlacement(db, U.r1a, sub, {
    rate: 77.5, city: "Plano", contacts: [{ kind: "vendor_poc", name: "Vera Poc", email: "vera@vendor.example", phone: "+14695550123" }],
  });
  return { placementId: p.id, eventId: await eventOf(p.id, "placement.created") };
}

async function eventOf(placementId: string, type: string): Promise<string> {
  const r = await db.admin.query<{ id: string }>(
    `SELECT id FROM eureka.outbox_event WHERE aggregate_id = $1 AND type = $2 ORDER BY created_at DESC LIMIT 1`, [placementId, type]);
  return r.rows[0]!.id;
}

const deliveries = async (eventId: string) => Object.fromEntries((await db.admin.query<{ user_id: string; status: string }>(
  "SELECT user_id, status FROM eureka.outbox_delivery WHERE event_id = $1", [eventId])).rows.map((r) => [r.user_id, r.status]));
const publishedAt = async (eventId: string) =>
  (await db.admin.query("SELECT published_at FROM eureka.outbox_event WHERE id = $1", [eventId])).rows[0]?.published_at ?? null;

async function addUser(key: string, roles: { role: string; ended?: boolean }[], status = "active") {
  const r = await db.admin.query<{ id: string }>(
    "INSERT INTO eureka.app_user (email, display_name, status) VALUES ($1, $2, $3) RETURNING id", [`${key}@eureka.example`, key, status]);
  for (const x of roles) {
    await db.admin.query(
      `INSERT INTO eureka.user_role (user_id, role_key, valid) VALUES ($1, $2,
         CASE WHEN $3 THEN tstzrange(now() - interval '2 days', now() - interval '1 day') ELSE tstzrange(now(), NULL) END)`,
      [r.rows[0]!.id, x.role, x.ended ?? false]);
  }
  extra[key] = r.rows[0]!.id;
}

const EXPECTED = ["acct@eureka.example", "dual@eureka.example", "hr@eureka.example", "imm@eureka.example"];

beforeAll(async () => {
  db = await createTestDb();
  await seedFixtures(db.admin);
  await addUser("dual", [{ role: "hr" }, { role: "accounts" }]);          // one email, both groups named
  await addUser("gonehr", [{ role: "hr" }], "inactive");                  // inactive user
  await addUser("exhr", [{ role: "hr", ended: true }]);                   // role ended
  await addUser("assochr", [{ role: "associate_hr" }]);                   // not a recipient group role
}, 120_000);

afterAll(async () => {
  await db?.drop();
});

describe("outbox_event privileges (migration 0024)", () => {
  it("the worker reads and publishes, but cannot change other columns, insert or delete live rows", async () => {
    const { eventId } = await newPlacement();
    expect((await db.worker.query("SELECT id FROM eureka.outbox_event WHERE id = $1", [eventId])).rowCount).toBe(1);
    expect(await denied(db.worker, "UPDATE eureka.outbox_event SET payload = '{}' WHERE id = $1", [eventId])).toMatch(/permission denied/);
    expect(await denied(db.worker, "UPDATE eureka.outbox_event SET type = 'x.y', published_at = now() WHERE id = $1", [eventId]))
      .toMatch(/permission denied/);
    expect(await denied(db.worker, `INSERT INTO eureka.outbox_event (type, aggregate_type, aggregate_id, payload)
      VALUES ('placement.created', 'placement', gen_random_uuid(), '{}')`)).toMatch(/permission denied/);
    // Unpublished and recently published rows cannot be deleted.
    expect((await db.worker.query("DELETE FROM eureka.outbox_event WHERE id = $1", [eventId])).rowCount).toBe(0);

    // Publishing: the database sets the time, once.
    await db.worker.query("UPDATE eureka.outbox_event SET published_at = '2000-01-01' WHERE id = $1", [eventId]);
    const r = await db.admin.query("SELECT published_at > now() - interval '1 minute' AS now FROM eureka.outbox_event WHERE id = $1", [eventId]);
    expect(r.rows[0].now).toBe(true);
    expect((await db.worker.query("UPDATE eureka.outbox_event SET published_at = now() WHERE id = $1", [eventId])).rowCount).toBe(0);
    expect((await db.worker.query("DELETE FROM eureka.outbox_event WHERE id = $1", [eventId])).rowCount).toBe(0);
    expect(await denied(db.worker, "TRUNCATE eureka.outbox_event")).toMatch(/permission denied/);
  });

  it("the app role cannot read or publish outbox rows; the owner and superusers cannot bypass the guard", async () => {
    const { eventId } = await newPlacement();
    expect(await denied(db.app, "UPDATE eureka.outbox_event SET published_at = now() WHERE id = $1", [eventId])).toMatch(/permission denied/);
    expect(await asUser(db.app, U.admin, (c) => c.query("SELECT 1 FROM eureka.outbox_event").then(() => "allowed", (e: Error) => e.message)))
      .toMatch(/permission denied/);
    expect(await denied(db.app, "SELECT 1 FROM eureka.outbox_delivery")).toMatch(/permission denied/);
    expect(await denied(db.admin, "UPDATE eureka.outbox_event SET published_at = now() WHERE id = $1", [eventId]))
      .toMatch(/only through placement functions/);
    expect(await denied(db.admin, "DELETE FROM eureka.outbox_event WHERE id = $1", [eventId])).toMatch(/only through placement functions/);
    expect(await denied(db.admin, "TRUNCATE eureka.outbox_event CASCADE")).toMatch(/only through placement functions/);
    expect(await publishedAt(eventId)).toBeNull();
  });

  it("delivery rows are state-machine guarded and hold no addresses", async () => {
    const { eventId } = await newPlacement();
    expect(await denied(db.worker, "INSERT INTO eureka.outbox_delivery (event_id, user_id, status) VALUES ($1, $2, 'sent')", [eventId, U.hr]))
      .toMatch(/permission denied/);
    await db.worker.query("INSERT INTO eureka.outbox_delivery (event_id, user_id) VALUES ($1, $2)", [eventId, U.hr]);
    expect(await denied(db.worker, "UPDATE eureka.outbox_delivery SET status = 'sent' WHERE event_id = $1", [eventId]))
      .toMatch(/invalid outbox delivery change/);
    await db.worker.query("UPDATE eureka.outbox_delivery SET status = 'skipped' WHERE event_id = $1", [eventId]);
    // The worker's update policy no longer matches a final row.
    expect((await db.worker.query("UPDATE eureka.outbox_delivery SET status = 'pending' WHERE event_id = $1", [eventId])).rowCount).toBe(0);
    const cols = await db.admin.query(`SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'eureka' AND table_name = 'outbox_delivery' ORDER BY ordinal_position`);
    expect(cols.rows.map((r) => r.column_name)).toEqual(["event_id", "user_id", "status", "created_at", "attempt_at", "done_at", "rejections"]);
    // Recipients cannot be added to a published event.
    await force("DELETE FROM eureka.outbox_delivery WHERE event_id = $1", [eventId]);
    await db.worker.query("UPDATE eureka.outbox_event SET published_at = now() WHERE id = $1", [eventId]);
    expect(await denied(db.worker, "INSERT INTO eureka.outbox_delivery (event_id, user_id) VALUES ($1, $2)", [eventId, U.hr]))
      .toMatch(/row-level security/);
  });

  it("new functions pin search_path and are not executable by PUBLIC", async () => {
    const { rows } = await db.admin.query(`
      SELECT p.proname, p.proconfig, has_function_privilege('public', p.oid, 'EXECUTE') AS pub
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'eureka' AND p.proname IN ('outbox_event_guard', 'outbox_delivery_guard')`);
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.proconfig, r.proname).toContain("search_path=pg_catalog, pg_temp");
      expect(r.pub, r.proname).toBe(false);
    }
  });
});

describe("outbox delivery", () => {
  it("emails each HR, Accounts and Immigration user once, with no personal data, and publishes", async () => {
    const { placementId, eventId } = await newPlacement();
    const mail = new FakeMail();
    const r = await deliverEvent(db.worker, mail, ORIGIN, eventId, ctx());
    expect(r).toEqual({ alreadyPublished: false, recipients: 4, sent: 4, skipped: 0, inDoubt: 0, failed: 0 });
    expect(mail.to()).toEqual(EXPECTED);
    expect(await publishedAt(eventId)).not.toBeNull();
    expect(Object.values(await deliveries(eventId))).toEqual(["sent", "sent", "sent", "sent"]);

    const m = mail.sent.find((x) => x.to === "hr@eureka.example")!;
    expect(m.subject).toBe("Eureka: new placement");
    expect(m.text).toContain("status: Confirmed");
    expect(m.text).toContain(placementId);
    expect(m.text).toContain(`${ORIGIN}/`);
    expect(m.text).toContain("as a member of HR.");
    expect(mail.sent.find((x) => x.to === "dual@eureka.example")!.text).toContain("as a member of Accounts and HR.");
    const person = (await db.admin.query(`SELECT p.first_name FROM eureka.placement pl JOIN eureka.candidate c ON c.id = pl.candidate_id
      JOIN eureka.person p ON p.id = c.person_id WHERE pl.id = $1`, [placementId])).rows[0].first_name;
    for (const x of mail.sent) {
      for (const secret of [person, "77.5", "Plano", "Vera", "vera@vendor.example", "4695550123", "Northwind", "r1a"]) {
        expect(`${x.subject}\n${x.text}`).not.toContain(secret);
      }
    }

    // A second run sends nothing.
    const again = await deliverEvent(db.worker, mail, ORIGIN, eventId, ctx());
    expect(again.alreadyPublished).toBe(true);
    expect(mail.sent).toHaveLength(4);
  });

  it("delivers state changes with the from/to statuses", async () => {
    const { placementId } = await newPlacement();
    await transitionPlacement(db, U.r1a, placementId, "paperwork");
    const eventId = await eventOf(placementId, "placement.state_changed");
    const mail = new FakeMail();
    await deliverEvent(db.worker, mail, ORIGIN, eventId, ctx());
    expect(mail.to()).toEqual(EXPECTED);
    expect(mail.sent[0]!.subject).toBe("Eureka: placement status changed to Paperwork");
    expect(mail.sent[0]!.text).toContain("from Confirmed to Paperwork");
  });

  it("fixes recipients at fan-out and skips those who left before their send", async () => {
    const { eventId } = await newPlacement();
    await addUser("leaver", [{ role: "immigration" }]);
    const mail = new FakeMail((m) => (m.to === "acct@eureka.example" ? new MailRejected("throttled") : null));
    await expect(deliverEvent(db.worker, mail, ORIGIN, eventId, ctx())).rejects.toThrow(/retry pending/);
    expect(mail.to()).toEqual(["dual@eureka.example", "hr@eureka.example", "imm@eureka.example", "leaver@eureka.example"]);
    // Recipients are fixed at fan-out: a later HR member is not added; acct
    // (still pending after the rejection) is deactivated before the retry.
    await addUser("latecomer", [{ role: "hr" }]);
    await db.admin.query("UPDATE eureka.app_user SET status = 'inactive' WHERE id = $1", [U.acct]);
    const ok = new FakeMail();
    const r = await deliverEvent(db.worker, ok, ORIGIN, eventId, ctx());
    expect(ok.sent).toHaveLength(0);
    expect(r).toMatchObject({ recipients: 5, sent: 4, skipped: 1 });
    expect((await deliveries(eventId))[U.acct]).toBe("skipped");
    await db.admin.query("UPDATE eureka.app_user SET status = 'active' WHERE id = $1", [U.acct]);
    await db.admin.query("UPDATE eureka.app_user SET status = 'inactive' WHERE id IN ($1, $2)", [extra.leaver, extra.latecomer]);
  });

  it("retries a provider rejection for that recipient only, without re-sending to the others", async () => {
    const { eventId } = await newPlacement();
    let reject = true;
    const mail = new FakeMail((m) => (reject && m.to === "imm@eureka.example" ? new MailRejected("throttled") : null));
    await expect(deliverEvent(db.worker, mail, ORIGIN, eventId, ctx())).rejects.toThrow(/rejected or throttled by the provider; retry pending/);
    expect(await publishedAt(eventId)).toBeNull();
    expect((await deliveries(eventId))[U.imm]).toBe("pending");
    reject = false;
    await deliverEvent(db.worker, mail, ORIGIN, eventId, ctx());
    expect(mail.to()).toEqual(EXPECTED);                                  // each exactly once
    expect(await publishedAt(eventId)).not.toBeNull();
  });

  it("does not resend after a crash between the provider accepting and the sent mark", async () => {
    const { eventId } = await newPlacement();
    const mail = new FakeMail();
    // The database goes away right after the first email is accepted.
    const crashing = {
      connect: () => db.worker.connect(),
      query: (sql: string, params?: unknown[]) => (sql.includes("SET status = $3")
        ? Promise.reject(new Error("connection terminated"))
        : db.worker.query(sql, params)),
    } as unknown as pg.Pool;
    await expect(deliverEvent(crashing, mail, ORIGIN, eventId, ctx())).rejects.toThrow(/connection terminated/);
    expect(mail.sent).toHaveLength(1);
    const first = mail.sent[0]!.to;
    expect(Object.values(await deliveries(eventId)).filter((s) => s === "sending")).toHaveLength(1);
    // Before the crashed run's lease has expired the row is left alone.
    await expect(deliverEvent(db.worker, mail, ORIGIN, eventId, ctx())).rejects.toThrow(/still open/);
    // Time travel past the lease window.
    await force("UPDATE eureka.outbox_delivery SET attempt_at = now() - interval '3 minutes' WHERE event_id = $1 AND status = 'sending'", [eventId]);

    const r = await deliverEvent(db.worker, mail, ORIGIN, eventId, ctx());
    expect(r).toMatchObject({ sent: 3, inDoubt: 1 });
    expect(mail.to()).toEqual(EXPECTED);                                  // the first recipient was not emailed again
    expect(mail.sent.filter((m) => m.to === first)).toHaveLength(1);
    expect(await publishedAt(eventId)).not.toBeNull();
  });

  it("treats an unknown transport outcome as in doubt and never resends it", async () => {
    const { eventId } = await newPlacement();
    const mail = new FakeMail((m) => (m.to === "hr@eureka.example" ? new Error("socket hang up") : null));
    const r = await deliverEvent(db.worker, mail, ORIGIN, eventId, ctx());
    expect(r).toMatchObject({ sent: 3, inDoubt: 1 });
    expect((await deliveries(eventId))[U.hr]).toBe("in_doubt");
    expect(await publishedAt(eventId)).not.toBeNull();
  });

  it("runs under the job runner: one key per event, done once", async () => {
    const { eventId } = await newPlacement();
    const mail = new FakeMail();
    const job = outboxDeliveryJob(mail, ORIGIN, { batchSize: 500 });
    const keys = await job.dueKeys(new Date(), { pool: db.worker, log: silentLogger });
    expect(keys).toContain(eventId);
    const runner = new JobRunner(db.worker, [job], silentLogger);
    expect(await runner.runOnce(job, eventId)).toBe("ran");
    expect(await runner.runOnce(job, eventId)).toBe("done-before");
    expect(mail.to()).toEqual(EXPECTED);
    expect(await dueOutboxEvents(db.worker, 500)).not.toContain(eventId);
    const detail = (await db.admin.query("SELECT detail FROM eureka.job_run WHERE job_name = 'outbox-delivery' AND run_key = $1", [eventId]))
      .rows[0].detail;
    expect(JSON.stringify(detail)).not.toContain("@");
  });

  it("a failing event backs off and does not block the batch", async () => {
    const { eventId } = await newPlacement();
    const job = outboxDeliveryJob(new FakeMail(() => new MailRejected("down")), ORIGIN, { batchSize: 500 });
    const runner = new JobRunner(db.worker, [job], silentLogger);
    expect(await runner.runOnce(job, eventId)).toBe("failed");
    expect(await dueOutboxEvents(db.worker, 500)).not.toContain(eventId);
    await db.admin.query("UPDATE eureka.job_run SET next_attempt_at = now() - interval '1 second' WHERE run_key = $1", [eventId]);
    expect(await dueOutboxEvents(db.worker, 500)).toContain(eventId);
    await deliverEvent(db.worker, new FakeMail(), ORIGIN, eventId, ctx());
  });
});

/** Runs fn on a superuser connection acting as eureka_owner, then rolls back. */
async function asOwner<T>(fn: (c: pg.PoolClient) => Promise<T>, noForce = false): Promise<T> {
  const c = await db.admin.connect();
  try {
    await c.query("BEGIN");
    await c.query("SET LOCAL ROLE eureka_owner");
    if (noForce) await c.query("ALTER TABLE eureka.outbox_delivery NO FORCE ROW LEVEL SECURITY");
    return await fn(c);
  } finally {
    await c.query("ROLLBACK").catch(() => undefined);
    c.release();
  }
}
const err = (p: Promise<unknown>) => p.then(() => "allowed", (e: Error) => e.message);

/** A delivered event whose rows are all final (sent). */
async function deliveredEvent() {
  const { eventId } = await newPlacement();
  await deliverEvent(db.worker, new FakeMail(), ORIGIN, eventId, ctx());
  return eventId;
}

describe("outbox hardening (migration 0029)", () => {
  it("final delivery rows cannot be reopened, even by a superuser bypassing RLS or the owner without FORCE", async () => {
    const eventId = await deliveredEvent();
    expect(await denied(db.admin, "UPDATE eureka.outbox_delivery SET status = 'pending' WHERE event_id = $1", [eventId]))
      .toMatch(/invalid outbox delivery change/);
    expect(await denied(db.admin, "UPDATE eureka.outbox_delivery SET rejections = 3 WHERE event_id = $1", [eventId]))
      .toMatch(/invalid outbox delivery change/);
    // The owner under FORCE ROW LEVEL SECURITY has no policy: it sees no rows at all.
    expect(await asOwner((c) => c.query("UPDATE eureka.outbox_delivery SET status = 'pending' WHERE event_id = $1", [eventId])
      .then((r) => r.rowCount))).toBe(0);
    // The owner can lift FORCE (it owns the table); the trigger still refuses.
    expect(await asOwner((c) => err(c.query("UPDATE eureka.outbox_delivery SET status = 'pending' WHERE event_id = $1", [eventId])), true))
      .toMatch(/invalid outbox delivery change/);
  });

  it("delivery rows cannot be deleted or truncated except with their pruned event", async () => {
    const eventId = await deliveredEvent();
    expect(await denied(db.worker, "DELETE FROM eureka.outbox_delivery WHERE event_id = $1", [eventId])).toMatch(/permission denied/);
    expect(await denied(db.worker, "TRUNCATE eureka.outbox_delivery")).toMatch(/permission denied/);
    expect(await denied(db.admin, "DELETE FROM eureka.outbox_delivery WHERE event_id = $1", [eventId]))
      .toMatch(/removed only with their event/);
    expect(await denied(db.admin, "TRUNCATE eureka.outbox_delivery")).toMatch(/never truncated/);
    expect(await asOwner((c) => err(c.query("DELETE FROM eureka.outbox_delivery WHERE event_id = $1", [eventId])), true))
      .toMatch(/removed only with their event/);
    expect(await asOwner((c) => err(c.query("TRUNCATE eureka.outbox_delivery")))).toMatch(/never truncated/);
    expect(Object.keys(await deliveries(eventId))).toHaveLength(4);
    // The cascade from a prunable event is allowed.
    await force("UPDATE eureka.outbox_event SET published_at = now() - interval '8 days' WHERE id = $1", [eventId]);
    expect((await db.worker.query("DELETE FROM eureka.outbox_event WHERE id = $1", [eventId])).rowCount).toBe(1);
    expect(Object.keys(await deliveries(eventId))).toHaveLength(0);
  });

  it("counts definite rejections per recipient and gives up after the maximum; throttling is not counted", async () => {
    const { eventId } = await newPlacement();
    let throttled = 0;
    const mail = new FakeMail((m) => {
      if (m.to === "acct@eureka.example") return new MailRejected("bad address");
      if (m.to === "imm@eureka.example" && throttled < 3) { throttled++; return new MailRejected("slow down", true); }
      return null;
    });
    const rej = async () => (await db.admin.query(
      "SELECT user_id, rejections, status FROM eureka.outbox_delivery WHERE event_id = $1 AND user_id IN ($2, $3) ORDER BY user_id",
      [eventId, U.acct, U.imm])).rows.map((r) => [r.user_id === U.acct ? "acct" : "imm", r.status, r.rejections]);
    await expect(deliverEvent(db.worker, mail, ORIGIN, eventId, ctx(), { maxRejections: 2 })).rejects.toThrow(/retry pending/);
    expect((await rej()).sort()).toEqual([["acct", "pending", 1], ["imm", "pending", 0]]);
    await expect(deliverEvent(db.worker, mail, ORIGIN, eventId, ctx(), { maxRejections: 2 })).rejects.toThrow(/retry pending/);
    expect((await rej()).sort()).toEqual([["acct", "failed", 2], ["imm", "pending", 0]]);
    await expect(deliverEvent(db.worker, mail, ORIGIN, eventId, ctx(), { maxRejections: 2 })).rejects.toThrow(/retry pending/);
    const r = await deliverEvent(db.worker, mail, ORIGIN, eventId, ctx(), { maxRejections: 2 });
    expect(r).toMatchObject({ sent: 3, failed: 1 });
    expect((await rej()).sort()).toEqual([["acct", "failed", 2], ["imm", "sent", 0]]);
    expect(mail.to()).toEqual(["dual@eureka.example", "hr@eureka.example", "imm@eureka.example"]);
    expect(await publishedAt(eventId)).not.toBeNull();
    // The worker cannot move the count by itself.
    const { eventId: other } = await newPlacement();
    await db.worker.query("INSERT INTO eureka.outbox_delivery (event_id, user_id) VALUES ($1, $2)", [other, U.hr]);
    expect(await denied(db.worker, "UPDATE eureka.outbox_delivery SET rejections = 1 WHERE event_id = $1", [other]))
      .toMatch(/invalid outbox delivery change/);
    expect(await denied(db.worker, "INSERT INTO eureka.outbox_delivery (event_id, user_id, rejections) VALUES ($1, $2, 3)", [other, U.acct]))
      .toMatch(/permission denied/);
    // Final rows are out of the worker's reach.
    expect((await db.worker.query("UPDATE eureka.outbox_delivery SET rejections = 0 WHERE event_id = $1", [eventId])).rowCount).toBe(0);
  });

  it("two workers interleaved by a lease takeover never send twice, and a fresh send is not marked in doubt", async () => {
    const { eventId } = await newPlacement();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let first = "";
    const slow = new FakeMail();
    const slowSend = slow.send.bind(slow);
    slow.send = async (m: Mail) => { if (!first) { first = m.to; await gate; } return slowSend(m); };
    const lines: string[] = [];
    const log = createLogger({}, (l) => lines.push(l));

    // Worker A starts and blocks inside the provider call for its first recipient.
    const a = deliverEvent(db.worker, slow, ORIGIN, eventId, { ...ctx(), log });
    while (!first) await new Promise((r) => setTimeout(r, 10));
    // Worker B takes over (A's lease expired): the young `sending` row is not touched.
    const fast = new FakeMail();
    await expect(deliverEvent(db.worker, fast, ORIGIN, eventId, { ...ctx(), log })).rejects.toThrow(/still open/);
    expect(fast.to()).not.toContain(first);
    expect(fast.sent).toHaveLength(3);
    expect(Object.values(await deliveries(eventId)).filter((s) => s === "in_doubt")).toHaveLength(0);
    release();
    await a;                                                    // A records its send; the others were taken by B
    expect([...slow.to(), ...fast.to()].sort()).toEqual(EXPECTED);
    expect(Object.values(await deliveries(eventId))).toEqual(["sent", "sent", "sent", "sent"]);
    expect(await publishedAt(eventId)).not.toBeNull();
  });

  it("a stale send is marked in doubt by the next worker; the late final update is logged, not applied", async () => {
    const { eventId } = await newPlacement();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let first = "";
    const slow = new FakeMail();
    const slowSend = slow.send.bind(slow);
    slow.send = async (m: Mail) => { if (!first) { first = m.to; await gate; } return slowSend(m); };
    const lines: string[] = [];
    const log = createLogger({}, (l) => lines.push(l));
    const a = deliverEvent(db.worker, slow, ORIGIN, eventId, { ...ctx(), log });
    while (!first) await new Promise((r) => setTimeout(r, 10));
    // A has been stuck longer than the lease: B marks the row in doubt and finishes the rest.
    const fast = new FakeMail();
    const r = await deliverEvent(db.worker, fast, ORIGIN, eventId, { ...ctx(), log }, { staleSendingMs: 0 });
    expect(r).toMatchObject({ sent: 3, inDoubt: 1 });
    expect(fast.to()).not.toContain(first);
    release();
    await a;
    expect(lines.some((l) => l.includes("outcome not recorded") && l.includes('"alert":true'))).toBe(true);
    expect(Object.values(await deliveries(eventId)).sort()).toEqual(["in_doubt", "sent", "sent", "sent"]);
    expect([...slow.to(), ...fast.to()].sort()).toEqual(EXPECTED);  // still one email each
  });

  it("an event without recipients stays unpublished, alerts and is retried", async () => {
    const id = (await db.admin.query<{ id: string }>("SELECT gen_random_uuid() AS id")).rows[0]!.id;
    await force(`INSERT INTO eureka.outbox_event (id, type, aggregate_type, aggregate_id, payload)
      VALUES ($1, 'placement.created', 'placement', gen_random_uuid(),
              '{"status":"confirmed","notify":["immigration"]}')`, [id]);
    await db.admin.query("UPDATE eureka.app_user SET status = 'inactive' WHERE id = $1", [U.imm]);
    const lines: string[] = [];
    const log = createLogger({}, (l) => lines.push(l));
    try {
      await expect(deliverEvent(db.worker, new FakeMail(), ORIGIN, id, { ...ctx(), log })).rejects.toThrow(/no recipients/);
      expect(lines.some((l) => l.includes("no recipients") && l.includes('"alert":true'))).toBe(true);
      expect(await publishedAt(id)).toBeNull();
      expect(await deliveries(id)).toEqual({});
    } finally {
      await db.admin.query("UPDATE eureka.app_user SET status = 'active' WHERE id = $1", [U.imm]);
    }
    const mail = new FakeMail();
    await deliverEvent(db.worker, mail, ORIGIN, id, ctx());
    expect(mail.to()).toEqual(["imm@eureka.example"]);
  });

  it("prunes old succeeded outbox-delivery job_run rows only, through a definer function", async () => {
    const key = () => db.admin.query<{ k: string }>("SELECT gen_random_uuid()::text AS k").then((r) => r.rows[0]!.k);
    const keys = { old: await key(), recent: await key(), failed: await key() };
    const row = (job: string, k: string, status: string, age: string) => force(
      `INSERT INTO eureka.job_run (job_name, run_key, status, finished_at, lease_until)
       VALUES ($1, $2, $3, now() - $4::interval, NULL)`, [job, k, status, age]);
    await row("outbox-delivery", keys.old, "succeeded", "40 days");
    await row("outbox-delivery", keys.recent, "succeeded", "2 days");
    await row("outbox-delivery", keys.failed, "failed", "40 days");
    await row("audit-export", "2019-01-01", "succeeded", "400 days");

    expect(await denied(db.worker, "DELETE FROM eureka.job_run WHERE run_key = $1", [keys.old])).toMatch(/permission denied/);
    await expect(pruneOutboxJobRuns(db.worker, 3, ctx())).rejects.toThrow(/between 7 and 3650/);
    expect(await pruneOutboxJobRuns(db.worker, 30, ctx())).toBe(1);
    const left = (await db.admin.query("SELECT run_key FROM eureka.job_run WHERE run_key = ANY ($1)",
      [[...Object.values(keys), "2019-01-01"]])).rows.map((r) => r.run_key).sort();
    expect(left).toEqual([keys.recent, keys.failed, "2019-01-01"].sort());
    // Nobody else deletes job_run history, superuser included.
    expect(await denied(db.admin, "DELETE FROM eureka.job_run WHERE run_key = '2019-01-01'")).toMatch(/job_run rows are kept/);
    expect(await denied(db.admin, "TRUNCATE eureka.job_run")).toMatch(/job_run rows are kept/);
    const fn = await db.admin.query(`SELECT has_function_privilege('eureka_app', 'eureka.prune_outbox_job_runs(integer)', 'EXECUTE') AS app,
      has_function_privilege('eureka_worker', 'eureka.prune_outbox_job_runs(integer)', 'EXECUTE') AS worker`);
    expect(fn.rows[0]).toEqual({ app: false, worker: true });
  });

  it("OUTBOX_DELIVER_SINCE marks older events published without sending", async () => {
    const { eventId: old } = await newPlacement();
    const { eventId: fresh } = await newPlacement();
    await force("UPDATE eureka.outbox_event SET created_at = now() - interval '2 days' WHERE id = $1", [old]);
    const mail = new FakeMail();
    const lines: string[] = [];
    const log = createLogger({}, (l) => lines.push(l));
    const job = outboxDeliveryJob(mail, ORIGIN, { batchSize: 500, deliverSince: new Date(Date.now() - 86_400_000) });
    const keys = await job.dueKeys(new Date(), { pool: db.worker, log });
    expect(keys).not.toContain(old);
    expect(keys).toContain(fresh);
    expect(await publishedAt(old)).not.toBeNull();
    expect(mail.sent).toHaveLength(0);
    expect(lines.some((l) => l.includes("OUTBOX_DELIVER_SINCE") && l.includes('"skipped":1'))).toBe(true);
    expect(() => loadWorkerConfig({ DATABASE_URL: "postgres://w@h/d", EXPORT_DIR: "/tmp/x", OUTBOX_DELIVER_SINCE: "yesterday" })).toThrow();
  });
});

describe("outbox prune", () => {
  it("deletes published events older than the retention, with their delivery rows", async () => {
    const ids: Record<string, string> = {};
    for (const [k, age] of [["old", 40], ["mid", 10], ["new", 3]] as const) {
      const { eventId } = await newPlacement();
      await deliverEvent(db.worker, new FakeMail(), ORIGIN, eventId, ctx());
      await force(`UPDATE eureka.outbox_event SET published_at = now() - $2 * interval '1 day' WHERE id = $1`, [eventId, age]);
      ids[k] = eventId;
    }
    const { eventId: unpublished } = await newPlacement();
    await force("UPDATE eureka.outbox_event SET created_at = now() - interval '100 days' WHERE id = $1", [unpublished]);

    expect(await pruneOutbox(db.worker, 30, ctx())).toBe(1);
    expect(await publishedAt(ids.old!)).toBeNull();
    expect((await db.admin.query("SELECT 1 FROM eureka.outbox_delivery WHERE event_id = $1", [ids.old])).rowCount).toBe(0);
    expect(await publishedAt(ids.mid!)).not.toBeNull();

    const job = outboxPruneJob(7);
    const runner = new JobRunner(db.worker, [job], silentLogger);
    expect(await runner.runOnce(job, "2020-01-01")).toBe("ran");
    expect(await publishedAt(ids.mid!)).toBeNull();
    expect(await publishedAt(ids.new!)).not.toBeNull();
    expect((await db.admin.query("SELECT 1 FROM eureka.outbox_event WHERE id = $1", [unpublished])).rowCount).toBe(1);

    // The database floor holds even if the job is misconfigured.
    await expect(pruneOutbox(db.worker, 3, ctx())).rejects.toThrow(/at least 7 days/);
    expect((await db.worker.query("DELETE FROM eureka.outbox_event WHERE id = $1", [ids.new])).rowCount).toBe(0);
  });
});

describe("idempotency-key cleanup", () => {
  it("deletes keys older than 24 hours only, and never reads stored responses", async () => {
    const add = (key: string) => asUser(db.app, U.r1a, (c) => c.query(
      `INSERT INTO eureka.idempotency_key (key, user_id, endpoint, request_hash) VALUES ($1, $2, 'POST /placements', $3)`,
      [key, U.r1a, "a".repeat(64)]), true);
    await add("old-key");
    await add("fresh-key");
    await force("UPDATE eureka.idempotency_key SET created_at = now() - interval '25 hours', response = '{\"id\":1}' WHERE key = 'old-key'");
    await force("UPDATE eureka.idempotency_key SET created_at = now() - interval '23 hours' WHERE key = 'fresh-key'");

    expect(await denied(db.worker, "SELECT response FROM eureka.idempotency_key")).toMatch(/permission denied/);
    expect((await db.worker.query("SELECT key FROM eureka.idempotency_key")).rows.map((r) => r.key)).toEqual(["old-key"]);
    expect((await db.worker.query("DELETE FROM eureka.idempotency_key WHERE key = 'fresh-key'")).rowCount).toBe(0);
    expect(await denied(db.worker, "UPDATE eureka.idempotency_key SET key = 'x'")).toMatch(/permission denied/);

    expect(await cleanupIdempotencyKeys(db.worker, ctx())).toBe(1);
    const left = (await db.admin.query("SELECT key FROM eureka.idempotency_key")).rows.map((r) => r.key);
    expect(left).toEqual(["fresh-key"]);

    // Time travel: an hour later the fresh key is due too (via the scheduled job).
    await force("UPDATE eureka.idempotency_key SET created_at = now() - interval '24 hours 1 minute' WHERE key = 'fresh-key'");
    const job = idempotencyCleanupJob();
    expect(await new JobRunner(db.worker, [job], silentLogger).runOnce(job, "2020-01-01")).toBe("ran");
    expect((await db.admin.query("SELECT count(*)::int AS n FROM eureka.idempotency_key")).rows[0].n).toBe(0);

    const idx = await db.admin.query("SELECT indexdef FROM pg_indexes WHERE indexname = 'idempotency_key_created'");
    expect(idx.rows[0].indexdef).toMatch(/\(created_at\)/);
  });
});

describe("schedules and configuration", () => {
  it("maintenance jobs run daily after 04:00 / 04:15 New York time", async () => {
    const due = (job: ReturnType<typeof outboxPruneJob>, iso: string) => job.dueKeys(new Date(iso), { pool: db.worker, log: silentLogger });
    expect(await due(outboxPruneJob(30), "2026-10-01T07:59:00Z")).toEqual([]);          // 03:59 EDT
    expect(await due(outboxPruneJob(30), "2026-10-01T08:00:00Z")).toEqual(["2026-09-30"]);
    expect(await due(idempotencyCleanupJob(), "2026-10-01T08:10:00Z")).toEqual([]);
    expect(await due(idempotencyCleanupJob(), "2026-10-01T08:15:00Z")).toEqual(["2026-09-30"]);
  });

  it("validates outbox settings", () => {
    const base = { DATABASE_URL: "postgres://w@localhost/db", EXPORT_DIR: "/tmp/x" };
    expect(loadWorkerConfig(base).OUTBOX_RETENTION_DAYS).toBe(30);
    expect(() => loadWorkerConfig({ ...base, OUTBOX_RETENTION_DAYS: "3" })).toThrow();
    expect(() => loadWorkerConfig({ ...base, OUTBOX_MAIL_MODE: "ses", AWS_REGION: "us-east-1", APP_PUBLIC_ORIGIN: "https://e.example" }))
      .toThrow(/OUTBOX_FROM_EMAIL/);
    expect(() => loadWorkerConfig({ ...base, OUTBOX_MAIL_MODE: "local", OUTBOX_MAIL_DIR: "/tmp/m" })).toThrow(/APP_PUBLIC_ORIGIN/);
    expect(() => loadWorkerConfig({ ...base, OUTBOX_MAIL_MODE: "local", OUTBOX_MAIL_DIR: "/tmp/m", APP_PUBLIC_ORIGIN: "https://e.example/x" }))
      .toThrow(/without a path/);
    expect(loadWorkerConfig({ ...base, OUTBOX_MAIL_MODE: "local", OUTBOX_MAIL_DIR: "/tmp/m", APP_PUBLIC_ORIGIN: "http://localhost:5173" })
      .OUTBOX_MAIL_MODE).toBe("local");
  });
});

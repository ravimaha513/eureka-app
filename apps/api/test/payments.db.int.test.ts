import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalMail } from "../src/worker/feedback-mail.js";
import { outboxDeliveryJob } from "../src/worker/jobs/outbox.js";
import { paymentDelayJob } from "../src/worker/jobs/payment-delay.js";
import { silentLogger } from "../src/worker/log.js";
import { JobRunner } from "../src/worker/runner.js";
import { asUser, createTestDb, ownedCandidateCalls, type TestDb } from "./db-harness.js";
import { asActor, joinedEmployee, type Joined } from "./employee-seed.js";
import { LOC, T, U, seedFixtures } from "./fixtures.js";
import { createPlacement, newCandidate, selectedSubmission } from "./placement-seed.js";
import { workerCtx } from "./notification-seed.js";

/**
 * Database-only checks for migration 0100 (payments / incentive dashboard):
 * every rule holds with the API removed (design B8): RLS by scope, definer
 * writes with their checks, guards, the derived status view, and the two
 * notifications delivered end to end.
 */
let db: TestDb;
let today: string;
let mailDir: string;

const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

beforeAll(async () => {
  db = await createTestDb();
  await seedFixtures(db.admin);
  today = (await db.admin.query<{ d: string }>("SELECT ((now() AT TIME ZONE 'America/New_York')::date)::text AS d")).rows[0]!.d;
  mailDir = await mkdtemp(join(tmpdir(), "eureka-pay-mail-"));
}, 120_000);

afterAll(async () => {
  await db?.drop();
  if (mailDir) await rm(mailDir, { recursive: true, force: true });
});

const CREATE = "SELECT authz.invoice_create($1, $2, $3::date, $4, $5::date, $6::date, $7::date, $8, $9, $10) AS id";
interface InvoiceArgs { no?: string | null; date?: string; terms?: number; amount?: number | null; hours?: number | null }
async function invoice(actor: string, placementId: string, a: InvoiceArgs = {}): Promise<string> {
  const rows = await asActor<{ id: string }>(db, actor, CREATE, [placementId, a.no ?? null, a.date ?? addDays(today, -40), a.terms ?? 30,
    null, null, null, a.hours === undefined ? 160 : a.hours, a.amount === undefined ? 9600 : a.amount, null]);
  return rows[0]!.id;
}
const pay = (actor: string, invoiceId: string, on: string, amount: number) =>
  asActor<{ payment_id: string; first_payment: boolean }>(db, actor, "SELECT * FROM authz.payment_record($1, $2::date, $3)", [invoiceId, on, amount]);
const status = async (id: string) => (await db.admin.query<{ status: string; delay_days: number | null; paid_amount: string; expected_date: string }>(
  "SELECT status, delay_days, paid_amount::text, expected_date::text FROM eureka.invoice_status WHERE id = $1", [id])).rows[0]!;
const visibleIds = (user: string, sql: string) =>
  asUser(db.app, user, async (c) => (await c.query<{ id: string }>(sql)).rows.map((r) => r.id));

describe("RLS: invoice:read over the placement, like placements", () => {
  let a: Joined, b: Joined;
  let ia: string, ib: string;
  beforeAll(async () => {
    a = await joinedEmployee(db, { actor: U.r1a, teamId: T.t1 });
    b = await joinedEmployee(db, { actor: U.r3a, teamId: T.t3, locationId: LOC.austin });
    ia = await invoice(U.acct, a.placementId);
    ib = await invoice(U.acct, b.placementId);
    await pay(U.acct, ia, today, 100);
    // More rows outside l3's scope (rule 3 checks below).
    for (let n = 0; n < 2; n++) await pay(U.acct, await invoice(U.acct, a.placementId), today, 10);
  });

  it.each([
    ["acct", true, true], ["ceo", true, true], ["ad", true, true],
    ["m1", true, false], ["m2", false, true], ["l1", true, false], ["l3", false, true],
    ["r1a", true, false], ["r1b", false, false], ["r3a", false, true],
    ["hr", false, false], ["imm", false, false], ["coach", false, false], ["locD", false, false], ["locA", false, false],
    ["admin", false, false],
  ] as const)("%s", async (key, seesA, seesB) => {
    const ids = await visibleIds(U[key], "SELECT id FROM eureka.invoice");
    expect(ids.includes(ia), "a").toBe(seesA);
    expect(ids.includes(ib), "b").toBe(seesB);
    const view = await visibleIds(U[key], "SELECT id FROM eureka.invoice_status");
    expect(view.includes(ia)).toBe(seesA);
    expect(view.includes(ib)).toBe(seesB);
    const pays = await asUser(db.app, U[key], async (c) => (await c.query("SELECT 1 FROM eureka.payment WHERE invoice_id = $1", [ia])).rowCount);
    expect(pays).toBe(seesA ? 1 : 0);
  });

  it("the app cannot write invoices or payments directly, nor execute the delay scan", async () => {
    await expect(asUser(db.app, U.acct, (c) => c.query("UPDATE eureka.invoice SET terms_days = 0 WHERE id = $1", [ia]))).rejects.toThrow(/permission denied/);
    await expect(asUser(db.app, U.acct, (c) => c.query("DELETE FROM eureka.payment"))).rejects.toThrow(/permission denied/);
    await expect(asUser(db.app, U.acct, (c) => c.query(
      "INSERT INTO eureka.invoice (placement_id, invoice_date, terms_days, created_by) VALUES ($1, $2, 30, $3)", [a.placementId, today, U.acct])))
      .rejects.toThrow(/permission denied/);
    await expect(asUser(db.app, U.acct, (c) => c.query("SELECT authz.emit_payment_delays($1::date)", [today]))).rejects.toThrow(/permission denied/);
    await expect(db.worker.query("SELECT authz.invoice_create(NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL)")).rejects.toThrow(/permission denied/);
  });

  it("guards refuse the owner too: no direct writes, no delete, no truncate", async () => {
    await expect(db.admin.query("UPDATE eureka.invoice SET terms_days = 0 WHERE id = $1", [ia])).rejects.toThrow(/only through payment functions/);
    await expect(db.admin.query("DELETE FROM eureka.payment WHERE invoice_id = $1", [ia])).rejects.toThrow(/only through payment functions/);
    await expect(db.admin.query("TRUNCATE eureka.payment, eureka.invoice")).rejects.toThrow(/never truncated/);
  });

  it("the read policy is planned with InitPlans and a hashed owned-candidate SubPlan (rule 3)", async () => {
    const { rows } = await db.admin.query(`SELECT pg_get_expr(polqual, polrelid) AS def FROM pg_policy WHERE polname = 'invoice_read'`);
    expect(rows[0].def).toMatch(/unnest\(\( SELECT authz\.owned_candidate_ids\('invoice:read'/);
    expect(rows[0].def).not.toMatch(/candidate_owned\(/);
    const plan = await asUser(db.app, U.r1a, async (c) =>
      (await c.query<{ "QUERY PLAN": string }>(`EXPLAIN SELECT count(*) FROM eureka.invoice`)).rows.map((r) => r["QUERY PLAN"]).join("\n"));
    expect(plan).toMatch(/hashed SubPlan/);
    // invoice:read here and placement:read through the placement probe: at most once per statement each, never per row.
    for (const t of ["invoice", "payment"]) {
      const total = (await db.admin.query(`SELECT count(*)::int AS n FROM eureka.${t}`)).rows[0].n as number;
      const { calls, rows } = await ownedCandidateCalls(db.admin, U.l3, `SELECT * FROM eureka.${t}`);
      expect(total - rows, t).toBeGreaterThan(1); // per-row resolution would then report more calls
      expect(calls, t).toBeGreaterThanOrEqual(1);
      expect(calls, t).toBeLessThanOrEqual(2);
    }
  });

  it("the view is security_invoker and every new function pins search_path and is not executable by PUBLIC", async () => {
    const v = await db.admin.query(`SELECT reloptions FROM pg_class WHERE oid = 'eureka.invoice_status'::regclass`);
    expect(v.rows[0].reloptions).toContain("security_invoker=true");
    const fns = await db.admin.query<{ proname: string; cfg: string[] | null; pub: boolean }>(`
      SELECT p.proname, p.proconfig AS cfg, has_function_privilege('public', p.oid, 'EXECUTE') AS pub
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'authz' AND (p.proname LIKE 'invoice%' OR p.proname LIKE 'payment%' OR p.proname = 'emit_payment_delays')`);
    expect(fns.rows.length).toBe(9);
    for (const f of fns.rows) {
      expect(f.cfg, f.proname).toContain("search_path=pg_catalog, pg_temp");
      expect(f.pub, f.proname).toBe(false);
    }
  });
});

describe("definer writes", () => {
  let j: Joined;
  beforeAll(async () => { j = await joinedEmployee(db, { actor: U.r2a, teamId: T.t2, locationId: LOC.austin }); });

  it("invoice:update is required over the placement; others get not_found or not_permitted", async () => {
    await expect(invoice(U.r2a, j.placementId)).rejects.toThrow(/not_permitted/); // can read (own), cannot update
    await expect(invoice(U.ceo, j.placementId)).rejects.toThrow(/not_permitted/);
    await expect(invoice(U.hr, j.placementId)).rejects.toThrow(/placement_not_found/);
    await expect(invoice(U.r1a, j.placementId)).rejects.toThrow(/placement_not_found/);
    await expect(db.app.query(CREATE, [j.placementId, null, today, 30, null, null, null, null, null, null])).rejects.toThrow(/placement_not_found/);
  });

  it("refuses placements that have not joined", async () => {
    const cand = await newCandidate(db, { teamId: T.t1, recruiterId: U.r1a, locationId: LOC.dallas });
    const p = await createPlacement(db, U.r1a, await selectedSubmission(db, U.r1a, cand.id));
    await expect(invoice(U.acct, p.id)).rejects.toThrow(/placement_not_joined/);
  });

  it("validates values NULL-safely and refuses future invoice dates and duplicate numbers", async () => {
    await expect(asActor(db, U.acct, CREATE, [j.placementId, null, null, 30, null, null, null, null, null, null])).rejects.toThrow(/invalid_invoice/);
    await expect(asActor(db, U.acct, CREATE, [j.placementId, null, today, null, null, null, null, null, null, null])).rejects.toThrow(/invalid_invoice/);
    await expect(invoice(U.acct, j.placementId, { date: addDays(today, 1) })).rejects.toThrow(/invalid_invoice/);
    await expect(invoice(U.acct, j.placementId, { terms: 181 })).rejects.toThrow(/invalid_invoice/);
    await expect(invoice(U.acct, j.placementId, { amount: -1 })).rejects.toThrow(/invalid_invoice/);
    await expect(asActor(db, U.acct, CREATE, [j.placementId, null, today, 30, null, today, addDays(today, -1), null, null, null])).rejects.toThrow(/invalid_invoice/);
    await invoice(U.acct, j.placementId, { no: "INV-7001" });
    await expect(invoice(U.acct, j.placementId, { no: " inv-7001 " })).rejects.toThrow(/invoice_no_exists/);
  });

  it("stamps server-managed columns and derives the expected date", async () => {
    const id = await invoice(U.acct, j.placementId, { date: addDays(today, -10), terms: 45 });
    const r = (await db.admin.query("SELECT row_version, created_by, updated_by, voided_at, expected_date::text AS e FROM eureka.invoice WHERE id = $1", [id])).rows[0];
    expect(r).toMatchObject({ row_version: 1, created_by: U.acct, updated_by: U.acct, voided_at: null, e: addDays(today, 35) });
    expect((await status(id)).status).toBe("pending");
  });

  it("updates with optimistic concurrency, refusing unknown keys and stale versions", async () => {
    const id = await invoice(U.acct, j.placementId, { date: addDays(today, -5), terms: 30 });
    const upd = (v: number | null, f: unknown) => asActor<{ v: number }>(db, U.acct, "SELECT authz.invoice_update($1, $2, $3::jsonb) AS v", [id, v, JSON.stringify(f)]);
    await expect(upd(2, { termsDays: 15 })).rejects.toThrow(/stale/);
    await expect(upd(null, { termsDays: 15 })).rejects.toThrow(/stale/);
    await expect(upd(1, { status: "received" })).rejects.toThrow(/invalid_invoice/);
    await expect(upd(1, { invoiceDate: null })).rejects.toThrow(/invalid_invoice/);
    await expect(upd(1, { invoiceDate: "not a date" })).rejects.toThrow(/invalid_invoice/);
    await expect(upd(1, {})).rejects.toThrow(/invalid_invoice/);
    expect((await upd(1, { termsDays: 0, invoiceDate: addDays(today, -3), amount: null }))[0]!.v).toBe(2);
    const s = await status(id);
    expect(s).toMatchObject({ expected_date: addDays(today, -3), status: "delayed", delay_days: 3 });
    await expect(asActor(db, U.r2a, "SELECT authz.invoice_update($1, 2, '{\"termsDays\": 5}'::jsonb)", [id])).rejects.toThrow(/not_permitted/);
  });

  it("payments: date on or after the invoice date, not in the future, no overpayment; status and delay follow", async () => {
    const id = await invoice(U.acct, j.placementId, { date: addDays(today, -40), terms: 30, amount: 1000 });
    expect(await status(id)).toMatchObject({ status: "delayed", delay_days: 10 });
    await expect(pay(U.acct, id, addDays(today, -41), 10)).rejects.toThrow(/invalid_payment_date/);
    await expect(pay(U.acct, id, addDays(today, 1), 10)).rejects.toThrow(/invalid_payment_date/);
    await expect(pay(U.acct, id, today, 0)).rejects.toThrow(/invalid_amount/);
    await expect(pay(U.acct, id, today, 1000.01)).rejects.toThrow(/overpayment/);
    await expect(pay(U.r2a, id, today, 10)).rejects.toThrow(/not_permitted/);
    await pay(U.acct, id, addDays(today, -12), 400);
    expect(await status(id)).toMatchObject({ status: "delayed", paid_amount: "400.00", delay_days: 10 });
    const [p2] = await pay(U.acct, id, addDays(today, -5), 600);
    expect(await status(id)).toMatchObject({ status: "received", paid_amount: "1000.00", delay_days: 5 });
    await expect(pay(U.acct, id, today, 1)).rejects.toThrow(/invoice_received/);
    // The amount cannot drop below what was received; the invoice date cannot move after a payment.
    await expect(asActor(db, U.acct, "SELECT authz.invoice_update($1, 1, '{\"amount\": 900}'::jsonb)", [id])).rejects.toThrow(/amount_below_received/);
    await expect(asActor(db, U.acct, "SELECT authz.invoice_update($1, 1, $2::jsonb)", [id, JSON.stringify({ invoiceDate: addDays(today, -6) })]))
      .rejects.toThrow(/invalid_invoice_date/);
    // Voiding a payment reopens the invoice; a voided payment is final; the invoice cannot be voided with live payments.
    await expect(asActor(db, U.acct, "SELECT authz.invoice_void($1, 1)", [id])).rejects.toThrow(/invoice_has_payments/);
    await asActor(db, U.acct, "SELECT authz.payment_void($1)", [p2!.payment_id]);
    await expect(asActor(db, U.acct, "SELECT authz.payment_void($1)", [p2!.payment_id])).rejects.toThrow(/payment_void/);
    expect((await status(id)).status).toBe("delayed");
    await expect(db.admin.query("UPDATE eureka.payment SET amount = 1 WHERE id = $1", [p2!.payment_id])).rejects.toThrow(/only through payment functions/);
  });

  it("void: version checked, final, excluded from the delay scan", async () => {
    const id = await invoice(U.acct, j.placementId, { date: addDays(today, -60), terms: 15 });
    await expect(asActor(db, U.acct, "SELECT authz.invoice_void($1, 9)", [id])).rejects.toThrow(/stale/);
    await asActor(db, U.acct, "SELECT authz.invoice_void($1, 1)", [id]);
    expect(await status(id)).toMatchObject({ status: "void", delay_days: null });
    await expect(asActor(db, U.acct, "SELECT authz.invoice_void($1, 2)", [id])).rejects.toThrow(/invoice_void/);
    await expect(pay(U.acct, id, today, 5)).rejects.toThrow(/invoice_void/);
    await expect(asActor(db, U.acct, "SELECT authz.invoice_update($1, 2, '{\"termsDays\": 5}'::jsonb)", [id])).rejects.toThrow(/invoice_void/);
    // The number of a voided invoice can be reused.
    const n1 = await invoice(U.acct, j.placementId, { no: "INV-VOID-1" });
    await asActor(db, U.acct, "SELECT authz.invoice_void($1, 1)", [n1]);
    await invoice(U.acct, j.placementId, { no: "INV-VOID-1" });
  });
});

describe("notifications", () => {
  const ORIGIN = "https://eureka.example";
  const eventsOf = async (type: string, aggregate: string) => (await db.admin.query<{ id: string; payload: Record<string, unknown> }>(
    "SELECT id, payload FROM eureka.outbox_event WHERE type = $1 AND aggregate_id = $2 ORDER BY created_at", [type, aggregate])).rows;
  async function deliver(eventId: string) {
    const job = outboxDeliveryJob(new LocalMail(mailDir), ORIGIN, { batchSize: 500 });
    expect(await job.dueKeys(new Date(), { pool: db.worker, log: silentLogger })).toContain(eventId);
    expect(await new JobRunner(db.worker, [job], silentLogger).runOnce(job, eventId)).toBe("ran");
    const inbox = (await db.admin.query<{ recipient_id: string; title: string; body: string; entity_type: string; entity_id: string }>(
      "SELECT recipient_id, title, body, entity_type, entity_id FROM eureka.notification WHERE event_id = $1 ORDER BY recipient_id", [eventId])).rows;
    const files = (await readdir(mailDir)).filter((f) => f.startsWith(eventId));
    const mails = await Promise.all(files.map(async (f) => JSON.parse(await readFile(join(mailDir, f), "utf8")) as { to: string; subject: string; text: string }));
    return { inbox, to: mails.map((m) => m.to).sort(), texts: [...mails.map((m) => `${m.subject}\n${m.text}`), ...inbox.map((x) => `${x.title} ${x.body}`)] };
  }
  const secrets = async (j: Joined) => {
    const p = (await db.admin.query<{ first_name: string }>(
      "SELECT p.first_name FROM eureka.candidate c JOIN eureka.person p ON p.id = c.person_id WHERE c.id = $1", [j.candidateId])).rows[0]!;
    return [p.first_name, "Northwind", "Team Rohit", "Team Anjali", "INV-", "9600.00", "1234.56"];
  };

  it("first payment of a placement: once, to the recruiter, lead and manager (email + inbox), no amounts or names", async () => {
    const j = await joinedEmployee(db, { actor: U.r1b, teamId: T.t1 });
    const i1 = await invoice(U.acct, j.placementId, { no: "INV-N1" });
    const i2 = await invoice(U.acct, j.placementId, { no: "INV-N2" });
    const [first] = await pay(U.acct, i1, today, 1234.56);
    expect(first!.first_payment).toBe(true);
    await asActor(db, U.acct, "SELECT authz.payment_void($1)", [first!.payment_id]);
    const [again] = await pay(U.acct, i1, today, 1234.56);
    const [other] = await pay(U.acct, i2, today, 50);
    expect([again!.first_payment, other!.first_payment]).toEqual([false, false]);
    const evs = await eventsOf("payment.first_received", j.placementId);
    expect(evs).toHaveLength(1);
    expect(evs[0]!.payload).toEqual({ placementId: j.placementId, invoiceId: i1, paymentId: first!.payment_id });
    const r = await deliver(evs[0]!.id);
    expect(r.inbox.map((x) => x.recipient_id)).toEqual([U.r1b, U.l1, U.m1].sort());
    expect(r.inbox[0]).toMatchObject({ title: "First payment received", entity_type: "placement", entity_id: j.placementId });
    expect(r.to).toEqual(["l1@eureka.example", "m1@eureka.example", "r1b@eureka.example"]);
    for (const t of r.texts) for (const s of await secrets(j)) expect(t, s).not.toContain(s);
  });

  it("payment-delay job: once per invoice and expected date, to the recruiter and lead only; re-armed by a new expected date", async () => {
    const j = await joinedEmployee(db, { actor: U.r2a, teamId: T.t2, locationId: LOC.austin });
    const late = await invoice(U.acct, j.placementId, { date: addDays(today, -50), terms: 30 }); // 20 days late
    const onTime = await invoice(U.acct, j.placementId, { date: addDays(today, -5), terms: 30 });
    const paid = await invoice(U.acct, j.placementId, { date: addDays(today, -50), terms: 30, amount: 100 });
    await pay(U.acct, paid, today, 100);
    const job = paymentDelayJob();
    await expect(job.run(addDays(today, 1), { ...workerCtx(), pool: db.worker } as never)).rejects.toThrow(/invalid payment-delay run/);
    const out = await job.run(today, { ...workerCtx(), pool: db.worker } as never);
    expect(out).toMatchObject({ emitted: expect.any(Number) });
    expect(await eventsOf("payment.delayed", onTime)).toHaveLength(0);
    expect(await eventsOf("payment.delayed", paid)).toHaveLength(0);
    const evs = await eventsOf("payment.delayed", late);
    expect(evs).toHaveLength(1);
    expect(evs[0]!.payload).toEqual({ invoiceId: late, placementId: j.placementId, daysLate: 20 });
    await job.run(today, { ...workerCtx(), pool: db.worker } as never);
    expect(await eventsOf("payment.delayed", late)).toHaveLength(1);
    const r = await deliver(evs[0]!.id);
    expect(r.inbox.map((x) => x.recipient_id)).toEqual([U.r2a, U.l2].sort());
    expect(r.inbox[0]).toMatchObject({ title: "Payment delayed by 20 days", entity_type: "placement", entity_id: j.placementId });
    expect(r.to).toEqual(["l2@eureka.example", "r2a@eureka.example"]);
    for (const t of r.texts) for (const s of await secrets(j)) expect(t, s).not.toContain(s);
    // New terms move the expected date: a new reminder once that date has passed too.
    await asActor(db, U.acct, "SELECT authz.invoice_update($1, 1, '{\"termsDays\": 40}'::jsonb)", [late]);
    await job.run(today, { ...workerCtx(), pool: db.worker } as never);
    const after = await eventsOf("payment.delayed", late);
    expect(after).toHaveLength(2);
    expect(after[1]!.payload).toMatchObject({ daysLate: 10 });
  });

  it("the resolver names nobody when the payload's invoice is not the placement's", async () => {
    const j = await joinedEmployee(db, { actor: U.r1a, teamId: T.t1 });
    const other = await joinedEmployee(db, { actor: U.r3a, teamId: T.t3 });
    const inv = await invoice(U.acct, other.placementId);
    const c = await db.admin.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL ROLE authz_definer");
      const ev = (await c.query<{ id: string }>(
        `INSERT INTO eureka.outbox_event (type, aggregate_type, aggregate_id, payload) VALUES ('payment.delayed', 'invoice', $1, $2) RETURNING id`,
        [inv, { invoiceId: inv, placementId: j.placementId, daysLate: 3 }])).rows[0]!.id;
      const r = await c.query("SELECT * FROM authz.notification_recipients($1)", [ev]);
      expect(r.rowCount).toBe(0);
      await c.query("ROLLBACK");
    } finally {
      c.release();
    }
  });
});

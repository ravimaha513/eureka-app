import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { can } from "@eureka/shared";
import { createApp } from "../src/app.module.js";
import { loadConfig } from "../src/platform/config.js";
import { createTestDb, type TestDb } from "./db-harness.js";
import { joinedEmployee, type Joined } from "./employee-seed.js";
import { LOC, T, U, seedFixtures, toUserAccess } from "./fixtures.js";
import { createPlacement, newCandidate, selectedSubmission } from "./placement-seed.js";

/** API checks for docs/payments-api.md (Payments / incentive dashboard). */
let db: TestDb;
let app: NestFastifyApplication;
let today: string;
const SECRET = "test-secret-test-secret-test-secret-123";
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

beforeAll(async () => {
  db = await createTestDb();
  await seedFixtures(db.admin);
  today = (await db.admin.query<{ d: string }>("SELECT ((now() AT TIME ZONE 'America/New_York')::date)::text AS d")).rows[0]!.d;
  const url = new URL(process.env.TEST_PG_ADMIN_URL ?? "postgres://postgres:postgres@127.0.0.1:5432");
  app = await createApp(loadConfig({
    NODE_ENV: "test", AUTH_MODE: "dev", SESSION_SECRET: SECRET,
    DATABASE_URL: `postgres://eureka_app:eureka_app_test@${url.host}/${db.name}`,
  }));
}, 120_000);

afterAll(async () => {
  await app?.close();
  await db?.drop();
});

type Key = keyof typeof U;
const ALL_KEYS = Object.keys(U) as Key[];
const sessions = new Map<string, { cookie: string; csrf: string }>();
async function login(key: Key) {
  const cached = sessions.get(key);
  if (cached) return cached;
  const res = await app.inject({ method: "POST", url: "/api/auth/dev-login", payload: { email: `${key}@eureka.example` } });
  expect(res.statusCode).toBe(204);
  const cookie = String(res.headers["set-cookie"]).split(";")[0]!;
  const me = await app.inject({ method: "GET", url: "/api/v1/me", headers: { cookie } });
  const s = { cookie, csrf: me.json().csrfToken as string };
  sessions.set(key, s);
  return s;
}
let keyN = 0;
async function call(key: Key, method: "GET" | "POST" | "PATCH", url: string, payload?: unknown, headers: Record<string, string> = {}) {
  const s = await login(key);
  return app.inject({
    method, url, payload: payload as never,
    headers: { cookie: s.cookie, ...(method !== "GET" ? { "x-csrf-token": s.csrf } : {}), ...headers },
  });
}
const newKey = () => ({ "idempotency-key": `k-${Date.now()}-${++keyN}` });
const audits = async (action: string, entityId?: string) => (await db.admin.query<{ actor_id: string; changes: Record<string, unknown> }>(
  `SELECT actor_id, changes FROM eureka.audit_event WHERE action = $1 AND ($2::uuid IS NULL OR entity_id = $2) ORDER BY seq`,
  [action, entityId ?? null])).rows;

async function createInvoice(placementId: string, body: Record<string, unknown> = {}) {
  const res = await call("acct", "POST", "/api/v1/invoices", {
    placementId, invoiceDate: addDays(today, -40), termsDays: 30, hours: 160, amount: 9876.5, ...body,
  }, newKey());
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id as string;
}

describe("permission matrix", () => {
  let j: Joined;
  let inv: string;
  beforeAll(async () => {
    j = await joinedEmployee(db, { actor: U.r1a, teamId: T.t1 });
    inv = await createInvoice(j.placementId);
  });

  // r1a's placement: recruiter own, lead l1, manager m1, AD, CEO and Accounts read it.
  const SEES = new Set<Key>(["r1a", "l1", "m1", "ad", "ceo", "acct"]);
  it.each(ALL_KEYS)("%s", async (k) => {
    const access = toUserAccess(k);
    const read = can(access, "invoice:read");
    for (const url of ["/api/v1/invoices", "/api/v1/invoices/summary", "/api/v1/invoices/placements"]) {
      expect((await call(k, "GET", url)).statusCode, url).toBe(read ? 200 : 403);
    }
    expect((await call(k, "GET", `/api/v1/invoices/${inv}`)).statusCode, "detail").toBe(!read ? 403 : SEES.has(k) ? 200 : 404);
    if (read) {
      const ids = (await call(k, "GET", "/api/v1/invoices")).json().items.map((i: { id: string }) => i.id);
      expect(ids.includes(inv), "list").toBe(SEES.has(k));
    }
    const update = can(access, "invoice:update");
    const writes: [string, "POST" | "PATCH", string][] = [
      ["create", "POST", "/api/v1/invoices"],
      ["patch", "PATCH", `/api/v1/invoices/${inv}`],
      ["void", "POST", `/api/v1/invoices/${inv}/void`],
      ["pay", "POST", `/api/v1/invoices/${inv}/payments`],
      ["voidPayment", "POST", `/api/v1/invoices/${inv}/payments/${inv}/void`],
    ];
    for (const [name, m, url] of writes) {
      expect((await call(k, m, url, { bogus: true }, newKey())).statusCode, name).toBe(update ? 422 : 403);
    }
  });
});

describe("Accounts raises an invoice and records payments", () => {
  let j: Joined;
  let inv: string;
  beforeAll(async () => {
    j = await joinedEmployee(db, { actor: U.r1b, teamId: T.t1 });
  });

  it("requires an Idempotency-Key, replays a repeat and refuses a reused key with another body", async () => {
    const body = { placementId: j.placementId, invoiceNo: "INV-A-1", invoiceDate: addDays(today, -40), termsDays: 30, hours: 160, amount: 9876.5,
      timesheetSubmittedOn: addDays(today, -42), periodStart: addDays(today, -70), periodEnd: addDays(today, -41), incentiveAmount: 250 };
    expect((await call("acct", "POST", "/api/v1/invoices", body)).statusCode).toBe(400);
    const key = newKey();
    const first = await call("acct", "POST", "/api/v1/invoices", body, key);
    expect(first.statusCode, first.body).toBe(201);
    inv = first.json().id;
    const again = await call("acct", "POST", "/api/v1/invoices", body, key);
    expect(again.statusCode).toBe(201);
    expect(again.json().id).toBe(inv);
    expect((await call("acct", "POST", "/api/v1/invoices", { ...body, termsDays: 45 }, key)).statusCode).toBe(409);
    // Same number on another invoice: 409 without naming the other one.
    const dup = await call("acct", "POST", "/api/v1/invoices", { ...body, invoiceNo: "inv-a-1" }, newKey());
    expect(dup.statusCode).toBe(409);
    expect(dup.json().detail).toBe("invoice_no_exists");
  });

  it("refuses server-managed fields, bad values and placements that have not joined", async () => {
    const base = { placementId: j.placementId, invoiceDate: today, termsDays: 30 };
    for (const extra of [{ status: "received" }, { expectedDate: today }, { rowVersion: 3 }, { termsDays: 181 }, { amount: 0 },
      { amount: 1.234 }, { invoiceDate: addDays(today, 1) }, { periodStart: today, periodEnd: addDays(today, -1) }]) {
      const r = await call("acct", "POST", "/api/v1/invoices", { ...base, ...extra }, newKey());
      expect(r.statusCode, JSON.stringify(extra)).toBe(422);
    }
    const cand = await newCandidate(db, { teamId: T.t1, recruiterId: U.r1a, locationId: LOC.dallas });
    const open = await createPlacement(db, U.r1a, await selectedSubmission(db, U.r1a, cand.id));
    const r = await call("acct", "POST", "/api/v1/invoices", { ...base, placementId: open.id }, newKey());
    expect(r.statusCode).toBe(422);
    expect(r.json().detail).toBe("placement_not_joined");
    expect((await call("acct", "POST", "/api/v1/invoices", { ...base, placementId: cand.id }, newKey())).statusCode).toBe(404);
  });

  it("lists the row with placement data joined, the computed dates and the hierarchy", async () => {
    const res = await call("acct", "GET", `/api/v1/invoices?placementId=${j.placementId}`);
    expect(res.statusCode).toBe(200);
    const [row] = res.json().items;
    expect(row).toMatchObject({
      id: inv, invoiceNo: "INV-A-1", status: "delayed", invoiceDate: addDays(today, -40), termsDays: 30,
      expectedDate: addDays(today, -10), delayDays: 10, hours: 160, amount: 9876.5, incentiveAmount: 250, paidAmount: 0, rate: 60,
      timesheetSubmittedOn: addDays(today, -42), periodStart: addDays(today, -70), periodEnd: addDays(today, -41),
      paymentCount: 0, receivedOn: null, rowVersion: 1,
      placement: { id: j.placementId, status: "joined", placementType: "w2" },
      candidate: { id: j.candidateId }, technology: "Java", client: { name: "Northwind Financial" },
      recruiter: { id: U.r1b, name: "r1b" }, team: { id: T.t1 }, lead: { id: U.l1, name: "l1" }, manager: { id: U.m1, name: "m1" },
      associateDirector: { id: U.ad, name: "ad" },
      actions: { edit: true, recordPayment: true, void: true },
    });
    expect(row.placement.joinedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(row.candidate.name).toMatch(/Placed$/);
  });

  it("field policy: Sales without rate:read see the row but no money; managers see it", async () => {
    const r = (await call("r1b", "GET", `/api/v1/invoices/${inv}`)).json();
    expect(r).toMatchObject({ id: inv, status: "delayed", delayDays: 10, hours: 160, actions: { edit: false, recordPayment: false, void: false } });
    for (const k of ["amount", "incentiveAmount", "paidAmount", "rate"]) expect(r, k).not.toHaveProperty(k);
    const lead = (await call("l1", "GET", `/api/v1/invoices?placementId=${j.placementId}`)).json().items[0];
    expect(lead).not.toHaveProperty("amount");
    const mgr = (await call("m1", "GET", `/api/v1/invoices/${inv}`)).json();
    expect(mgr).toMatchObject({ amount: 9876.5, rate: 60 });
    expect((await call("r1b", "GET", "/api/v1/invoices/summary")).json()).not.toHaveProperty("totals");
    const pl = (await call("r1b", "GET", "/api/v1/invoices/placements")).json().items.find((p: { id: string }) => p.id === j.placementId);
    expect(pl).toMatchObject({ invoiceCount: 1, actions: { createInvoice: false } });
    expect(pl).not.toHaveProperty("rate");
  });

  it("patch: If-Match required and checked, strict body, new expected date", async () => {
    const url = `/api/v1/invoices/${inv}`;
    expect((await call("acct", "PATCH", url, { termsDays: 45 })).statusCode).toBe(428);
    expect((await call("acct", "PATCH", url, { termsDays: 45 }, { "if-match": '"7"' })).statusCode).toBe(412);
    expect((await call("acct", "PATCH", url, { status: "received" }, { "if-match": '"1"' })).statusCode).toBe(422);
    expect((await call("acct", "PATCH", url, {}, { "if-match": '"1"' })).statusCode).toBe(422);
    const ok = await call("acct", "PATCH", url, { termsDays: 45, invoiceNo: null }, { "if-match": '"1"' });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toEqual({ id: inv, rowVersion: 2 });
    const r = (await call("acct", "GET", url)).json();
    expect(r).toMatchObject({ invoiceNo: null, termsDays: 45, expectedDate: addDays(today, 5), status: "pending", delayDays: 0, rowVersion: 2 });
    const [a] = await audits("invoice.updated", inv);
    expect(a!.changes).toEqual({ fields: ["invoiceNo", "termsDays"], termsDays: 45 });
  });

  it("payments: idempotent, the first one flagged, status received, more refused; void reopens", async () => {
    const url = `/api/v1/invoices/${inv}/payments`;
    expect((await call("acct", "POST", url, { receivedOn: today, amount: 100 })).statusCode).toBe(400);
    const key = newKey();
    const p1 = await call("acct", "POST", url, { receivedOn: addDays(today, -1), amount: 4000 }, key);
    expect(p1.statusCode, p1.body).toBe(201);
    expect(p1.json()).toMatchObject({ invoiceId: inv, firstPayment: true });
    const replay = await call("acct", "POST", url, { receivedOn: addDays(today, -1), amount: 4000 }, key);
    expect(replay.json()).toEqual(p1.json());
    expect((await call("acct", "POST", url, { receivedOn: today, amount: 6000 }, newKey())).json().detail).toBe("overpayment");
    expect((await call("acct", "POST", url, { receivedOn: addDays(today, 1), amount: 1 }, newKey())).statusCode).toBe(422);
    const p2 = await call("acct", "POST", url, { receivedOn: today, amount: 5876.5 }, newKey());
    expect(p2.json().firstPayment).toBe(false);
    const d = (await call("acct", "GET", `/api/v1/invoices/${inv}`)).json();
    expect(d).toMatchObject({ status: "received", paidAmount: 9876.5, receivedOn: today, firstReceivedOn: addDays(today, -1), delayDays: 0,
      actions: { edit: true, recordPayment: false, void: false } });
    expect(d.payments).toHaveLength(2);
    expect(d.payments[0]).toMatchObject({ receivedOn: addDays(today, -1), amount: 4000, recordedBy: "acct", voidedAt: null, actions: { void: true } });
    const sales = (await call("r1b", "GET", `/api/v1/invoices/${inv}`)).json();
    expect(sales.payments[0]).not.toHaveProperty("amount");
    expect((await call("acct", "POST", url, { receivedOn: today, amount: 1 }, newKey())).json().detail).toBe("invoice_received");
    // Void the second payment: the invoice is open again.
    const v = await call("acct", "POST", `${url}/${p2.json().id}/void`, {});
    expect(v.statusCode, v.body).toBe(200);
    expect((await call("acct", "POST", `${url}/${p2.json().id}/void`, {})).json().detail).toBe("payment_void");
    expect((await call("acct", "POST", `${url}/${inv}/void`, {})).statusCode).toBe(404);
    expect((await call("acct", "GET", `/api/v1/invoices/${inv}`)).json().status).toBe("pending");
    // Audit: ids, dates and flags, never amounts.
    const rec = await audits("payment.recorded", inv);
    expect(rec).toHaveLength(2);
    expect(rec[0]!.changes).toEqual({ paymentId: p1.json().id, placementId: j.placementId, receivedOn: addDays(today, -1), firstPayment: true });
    const all = JSON.stringify((await db.admin.query(
      "SELECT changes FROM eureka.audit_event WHERE action LIKE 'invoice.%' OR action LIKE 'payment.%'")).rows);
    for (const s of ["9876", "4000", "5876", "INV-A-1", "250"]) expect(all, s).not.toContain(s);
  });

  it("void: If-Match, refused with live payments, then gone from the default list", async () => {
    const other = await createInvoice(j.placementId, { invoiceDate: addDays(today, -3) });
    expect((await call("acct", "POST", `/api/v1/invoices/${inv}/void`, {}, { "if-match": '"2"' })).json().detail).toBe("invoice_has_payments");
    expect((await call("acct", "POST", `/api/v1/invoices/${other}/void`, {})).statusCode).toBe(428);
    expect((await call("acct", "POST", `/api/v1/invoices/${other}/void`, {}, { "if-match": '"1"' })).statusCode).toBe(200);
    const list = (await call("acct", "GET", `/api/v1/invoices?placementId=${j.placementId}`)).json().items.map((i: { id: string }) => i.id);
    expect(list).toEqual([inv]);
    const voided = (await call("acct", "GET", `/api/v1/invoices?placementId=${j.placementId}&status=void`)).json().items;
    expect(voided.map((i: { id: string }) => i.id)).toEqual([other]);
    expect(voided[0].actions).toEqual({ edit: false, recordPayment: false, void: false });
    expect((await call("acct", "PATCH", `/api/v1/invoices/${other}`, { termsDays: 1 }, { "if-match": '"2"' })).json().detail).toBe("invoice_void");
  });

  it("404 for an unknown invoice, even for Accounts", async () => {
    const missing = "00000000-0000-4000-8000-000000000000";
    expect((await call("acct", "GET", `/api/v1/invoices/${missing}`)).statusCode).toBe(404);
    expect((await call("acct", "PATCH", `/api/v1/invoices/${missing}`, { termsDays: 1 }, { "if-match": '"1"' })).statusCode).toBe(404);
    expect((await call("acct", "POST", `/api/v1/invoices/${missing}/payments`, { receivedOn: today, amount: 1 }, newKey())).statusCode).toBe(404);
  });
});

describe("dashboard filters, summary and billable placements", () => {
  let a: Joined, b: Joined;
  let late: string, onTime: string, paid: string;
  beforeAll(async () => {
    a = await joinedEmployee(db, { actor: U.r2a, teamId: T.t2, locationId: LOC.austin });
    b = await joinedEmployee(db, { actor: U.r3a, teamId: T.t3 });
    late = await createInvoice(a.placementId, { invoiceDate: addDays(today, -60), termsDays: 30, amount: 1000 });
    onTime = await createInvoice(a.placementId, { invoiceDate: addDays(today, -5), termsDays: 30, amount: 500 });
    paid = await createInvoice(b.placementId, { invoiceDate: addDays(today, -20), termsDays: 15, amount: 300 });
    expect((await call("acct", "POST", `/api/v1/invoices/${paid}/payments`, { receivedOn: addDays(today, -2), amount: 300 }, newKey())).statusCode).toBe(201);
  });

  it("filters by status, team, recruiter and invoice date, with keyset paging", async () => {
    const ids = async (qs: string) => (await call("acct", "GET", `/api/v1/invoices?${qs}`)).json().items.map((i: { id: string }) => i.id);
    expect(await ids(`teamId=${T.t2}&status=delayed`)).toEqual([late]);
    expect(await ids(`teamId=${T.t2}&status=pending`)).toEqual([onTime]);
    expect(await ids(`recruiterId=${U.r3a}&status=received`)).toEqual([paid]);
    expect(await ids(`teamId=${T.t2}&from=${addDays(today, -10)}`)).toEqual([onTime]);
    expect((await call("acct", "GET", `/api/v1/invoices?from=${today}&to=${addDays(today, -1)}`)).statusCode).toBe(422);
    const p1 = (await call("acct", "GET", `/api/v1/invoices?teamId=${T.t2}&limit=1`)).json();
    expect(p1.items.map((i: { id: string }) => i.id)).toEqual([onTime]);
    const p2 = (await call("acct", "GET", `/api/v1/invoices?teamId=${T.t2}&limit=1&cursor=${p1.nextCursor}`)).json();
    expect(p2.items.map((i: { id: string }) => i.id)).toEqual([late]);
    expect(p2.nextCursor).toBeNull();
    const row = (await call("acct", "GET", `/api/v1/invoices/${paid}`)).json();
    expect(row).toMatchObject({ status: "received", expectedDate: addDays(today, -5), receivedOn: addDays(today, -2), delayDays: 3 });
  });

  it("summary: counts by status, the longest delay and totals for viewers of money", async () => {
    const s = (await call("acct", "GET", `/api/v1/invoices/summary?teamId=${T.t2}`)).json();
    expect(s).toEqual({ counts: { pending: 1, delayed: 1, received: 0 }, maxDelayDays: 30,
      totals: { invoiced: 1500, received: 0, outstanding: 1500 }, amountsHidden: 0 });
    const l2 = (await call("l2", "GET", "/api/v1/invoices/summary")).json();
    expect(l2).toEqual({ counts: { pending: 1, delayed: 1, received: 0 }, maxDelayDays: 30 });
    const m2 = (await call("m2", "GET", "/api/v1/invoices/summary")).json();
    expect(m2).toMatchObject({ counts: { pending: 0, delayed: 0, received: 1 }, totals: { invoiced: 300, received: 300, outstanding: 0 } });
  });

  it("billable placements: joined placements in scope with their invoice counts", async () => {
    const items = (await call("acct", "GET", "/api/v1/invoices/placements?limit=200")).json().items as { id: string; invoiceCount: number }[];
    expect(items.find((p) => p.id === a.placementId)).toMatchObject({ invoiceCount: 2, actions: { createInvoice: true }, rate: 60 });
    const fresh = await joinedEmployee(db, { actor: U.r2a, teamId: T.t2, locationId: LOC.austin });
    const un = (await call("acct", "GET", "/api/v1/invoices/placements?uninvoiced=true&limit=200")).json().items.map((p: { id: string }) => p.id);
    expect(un).toContain(fresh.placementId);
    expect(un).not.toContain(a.placementId);
    const r2a = (await call("r2a", "GET", "/api/v1/invoices/placements")).json().items.map((p: { id: string }) => p.id);
    expect(r2a).toContain(a.placementId);
    expect(r2a).not.toContain(b.placementId);
  });
});

import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activityVisible, can, checklistTemplateAccess, resolveScope, type ActivityRef } from "@eureka/shared";
import { createApp } from "../src/app.module.js";
import { loadConfig } from "../src/platform/config.js";
import { asUser, createTestDb, type TestDb } from "./db-harness.js";
import { LOC, T, U, seedFixtures, toUserAccess } from "./fixtures.js";
import { createPlacement, newCandidate, selectedSubmission, transitionPlacement } from "./placement-seed.js";

/**
 * API checks for paperwork progress, BGC and templates (migration 0044,
 * docs/paperwork-api.md): permission matrix, document:read scope per fixture
 * user, state machines, read-before-write order and the audit (rule 5).
 */
let db: TestDb;
let app: NestFastifyApplication;
const SECRET = "test-secret-test-secret-test-secret-123";

const W2 = [
  { doc_type: "sample_doc_a", owner_role: "hr", required: true },
  { doc_type: "sample_doc_b", owner_role: "immigration" },
  { doc_type: "sample_doc_c", owner_role: "accounts", required: false },
];

beforeAll(async () => {
  db = await createTestDb();
  await seedFixtures(db.admin);
  await db.admin.query(`INSERT INTO authz.checklist_template (kind, placement_type, items) VALUES ('paperwork', 'w2', $1::jsonb)`,
    [JSON.stringify(W2)]);
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
const users = Object.keys(U) as Key[];
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

async function call(key: Key, method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: unknown) {
  const s = await login(key);
  return app.inject({
    method, url, payload: payload as never,
    headers: { cookie: s.cookie, ...(method !== "GET" ? { "x-csrf-token": s.csrf } : {}) },
  });
}

type Cand = Parameters<typeof newCandidate>[1];
const R1A: Cand = { teamId: T.t1, recruiterId: U.r1a, locationId: LOC.dallas };
async function placed(actor = U.r1a, cand: Cand = R1A) {
  const c = await newCandidate(db, cand);
  const sub = await selectedSubmission(db, actor, c.id);
  const p = await createPlacement(db, actor, sub, { type: "w2" });
  const pl = (await db.admin.query(`SELECT * FROM eureka.placement WHERE id = $1`, [p.id])).rows[0];
  const ref: ActivityRef = { recruiterId: pl.recruiter_id, teamId: pl.team_id, locationId: pl.location_id,
    candidate: { ...c, marketingStatus: "confirmation" } };
  return { id: p.id as string, cand: c, ref };
}
const itemId = async (placementId: string, docType = "sample_doc_a") => (await db.admin.query(
  `SELECT id FROM eureka.checklist_item WHERE placement_id = $1 AND doc_type = $2`, [placementId, docType])).rows[0].id as string;
const auditOf = async (entityId: string) => (await db.admin.query(
  `SELECT action, changes FROM eureka.audit_event WHERE entity_id = $1 ORDER BY seq`, [entityId])).rows;

describe("work queue: document:read scope per fixture user", () => {
  const made: Awaited<ReturnType<typeof placed>>[] = [];

  beforeAll(async () => {
    const plan: { actor: string; cand: Cand }[] = [
      { actor: U.r1a, cand: R1A },
      { actor: U.r1b, cand: { teamId: T.t1, recruiterId: U.r1b, locationId: LOC.austin } },
      { actor: U.r2a, cand: { teamId: T.t2, recruiterId: U.r2a, locationId: LOC.austin } },
      { actor: U.r2a, cand: { teamId: T.t3, recruiterId: U.r3a, locationId: LOC.dallas, visibility: "all_teams" } },
      { actor: U.r3a, cand: { teamId: T.t3, recruiterId: U.r3a, locationId: LOC.austin } },
    ];
    for (const { actor, cand } of plan) made.push(await placed(actor, cand));
  }, 60_000);

  it.each(users)("%s", async (key) => {
    const access = toUserAccess(key);
    const res = await call(key, "GET", "/api/v1/paperwork?view=all&limit=200");
    if (!can(access, "document:read")) {
      expect(res.statusCode).toBe(403);
      return;
    }
    expect(res.statusCode, res.body).toBe(200);
    const ids = new Set(made.map((m) => m.id));
    const seen = res.json().items.map((r: { placementId: string }) => r.placementId).filter((i: string) => ids.has(i)).sort();
    const docs = resolveScope(access, "document:read");
    expect(seen).toEqual(made.filter((m) => activityVisible(docs, m.ref)).map((m) => m.id).sort());
    // The placement record itself only where placement:read covers it (Immigration: null).
    const pls = resolveScope(access, "placement:read");
    for (const r of res.json().items.filter((x: { placementId: string }) => ids.has(x.placementId))) {
      const m = made.find((x) => x.id === r.placementId)!;
      expect(r.placement === null, `${key} placement`).toBe(!activityVisible(pls, m.ref));
      expect(r.checklist).toMatchObject({ total: 3, requiredOpen: 2 });
    }
    // Detail: 200 inside the scope, 404 outside.
    for (const m of made) {
      const d = await call(key, "GET", `/api/v1/paperwork/placements/${m.id}`);
      expect(d.statusCode, `${key} ${m.id}`).toBe(activityVisible(docs, m.ref) ? 200 : 404);
    }
  });

  it("queue rows carry counts, BGC status and a cursor; filters narrow them", async () => {
    const m = await placed();
    await call("hr", "PATCH", `/api/v1/paperwork/items/${await itemId(m.id)}`, { dueOn: "2020-01-02", assigneeId: U.hr });
    await call("hr", "PATCH", `/api/v1/paperwork/placements/${m.id}/bgc`, { status: "initiated" });
    const overdue = (await call("hr", "GET", "/api/v1/paperwork?view=overdue")).json().items;
    expect(overdue.map((r: { placementId: string }) => r.placementId)).toContain(m.id);
    const row = overdue.find((r: { placementId: string }) => r.placementId === m.id);
    expect(row).toMatchObject({
      candidate: { id: m.cand.id, name: expect.stringMatching(/^PlCand/) }, recruiter: { id: U.r1a, name: "r1a" },
      placement: { status: "confirmed", placementType: "w2", tentativeStart: "2031-01-05" },
      checklist: { total: 3, open: 3, requiredOpen: 2, overdue: 1, nextDue: "2020-01-02" }, bgc: { status: "initiated" },
    });
    // Soonest due first.
    expect(overdue[0].placementId).toBe(m.id);
    const mine = (await call("hr", "GET", "/api/v1/paperwork?mine=true&view=all")).json().items;
    expect(mine.map((r: { placementId: string }) => r.placementId)).toEqual([m.id]);
    expect(mine[0].checklist.total).toBe(1);
    const byRole = (await call("hr", "GET", "/api/v1/paperwork?ownerRole=accounts&view=all&limit=200")).json().items;
    expect(byRole.every((r: { checklist: { total: number } }) => r.checklist.total === 1)).toBe(true);
    const byBgc = (await call("hr", "GET", "/api/v1/paperwork?bgcStatus=initiated&view=all")).json().items;
    expect(byBgc.map((r: { placementId: string }) => r.placementId)).toEqual([m.id]);
    // Paging covers every row exactly once.
    const all = new Set<string>();
    let cursor: string | null = null;
    do {
      const page: { items: { placementId: string }[]; nextCursor: string | null } =
        (await call("hr", "GET", `/api/v1/paperwork?view=all&limit=2${cursor ? `&cursor=${cursor}` : ""}`)).json();
      for (const r of page.items) { expect(all.has(r.placementId)).toBe(false); all.add(r.placementId); }
      cursor = page.nextCursor;
    } while (cursor);
    const total = (await call("hr", "GET", "/api/v1/paperwork?view=all&limit=200")).json().items.length;
    expect(all.size).toBe(total);
    expect((await call("hr", "GET", "/api/v1/paperwork?view=sideways")).statusCode).toBe(422);
    expect((await call("hr", "GET", "/api/v1/paperwork?teamId=x")).statusCode).toBe(422);
  });

  it("outstanding hides placements with every item done and the check finished", async () => {
    const m = await placed();
    for (const doc of ["sample_doc_a", "sample_doc_b", "sample_doc_c"]) {
      const id = await itemId(m.id, doc);
      expect((await call("hr", "PATCH", `/api/v1/paperwork/items/${id}`, { status: "received" })).statusCode).toBe(200);
      expect((await call("hr", "PATCH", `/api/v1/paperwork/items/${id}`, { status: "verified" })).statusCode).toBe(200);
    }
    const ids = async () => (await call("hr", "GET", "/api/v1/paperwork?limit=200")).json().items.map((r: { placementId: string }) => r.placementId);
    expect(await ids()).toContain(m.id); // BGC not started on an open placement
    await call("hr", "PATCH", `/api/v1/paperwork/placements/${m.id}/bgc`, { status: "initiated" });
    await call("hr", "PATCH", `/api/v1/paperwork/placements/${m.id}/bgc`, { status: "cleared", actualStart: "2026-12-01" });
    expect(await ids()).not.toContain(m.id);
  });
});

describe("item updates", () => {
  it("receive, verify, waive and return with read-before-write order (404 / 403 / 422) and a clean audit", async () => {
    const m = await placed();
    const item = await itemId(m.id);
    expect((await call("r2a", "PATCH", `/api/v1/paperwork/items/${item}`, { status: "received" })).statusCode).toBe(404);
    expect((await call("acct", "PATCH", `/api/v1/paperwork/items/${item}`, { status: "received" })).statusCode).toBe(403); // no document:upload
    expect((await call("r1a", "PATCH", `/api/v1/paperwork/items/${item}`, { dueOn: "2031-01-01" })).statusCode).toBe(403);
    let res = await call("r1a", "PATCH", `/api/v1/paperwork/items/${item}`, { status: "received", notes: "Fictional: copy in the shared drive" });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ id: item, status: "received", notes: "Fictional: copy in the shared drive", version: 2,
      actions: { transition: [], editNotes: true, assign: false } });
    expect((await call("r1a", "PATCH", `/api/v1/paperwork/items/${item}`, { status: "verified" })).statusCode).toBe(403);
    expect((await call("hr", "PATCH", `/api/v1/paperwork/items/${item}`, { status: "waived" })).json().detail).toBe("reason_required");
    expect((await call("hr", "PATCH", `/api/v1/paperwork/items/${item}`, { status: "received" })).json().detail).toBe("invalid_transition");
    expect((await call("hr", "PATCH", `/api/v1/paperwork/items/${item}`, { status: "verified", expectedVersion: 1 })).statusCode).toBe(409);
    res = await call("hr", "PATCH", `/api/v1/paperwork/items/${item}`, { status: "pending", reason: "Fictional: unreadable scan", expectedVersion: 2 });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ status: "pending", statusReason: "Fictional: unreadable scan",
      actions: { transition: ["received", "waived"], editNotes: true, assign: true } });
    res = await call("hr", "PATCH", `/api/v1/paperwork/items/${item}`, { assigneeId: U.acct });
    expect([res.statusCode, res.json().detail]).toEqual([422, "invalid_assignee"]);
    res = await call("imm", "PATCH", `/api/v1/paperwork/items/${item}`, { assigneeId: U.hr, dueOn: "2031-01-31" });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ assignee: { id: U.hr, name: "hr" }, dueOn: "2031-01-31", overdue: false });

    const audit = await auditOf(item);
    expect(audit.map((a) => a.action)).toEqual(["checklist_item.update", "checklist_item.update", "checklist_item.update"]);
    expect(audit[0].changes).toEqual({ placementId: m.id, docType: "sample_doc_a", fields: ["status", "notes"], from: "pending", to: "received" });
    expect(audit[1].changes).toEqual({ placementId: m.id, docType: "sample_doc_a", fields: ["status"], from: "received", to: "pending", reasonGiven: true });
    expect(JSON.stringify(audit)).not.toMatch(/Fictional/);

    const hist = await call("hr", "GET", `/api/v1/paperwork/items/${item}/history`);
    expect(hist.statusCode).toBe(200);
    expect(hist.json().items.map((e: { from: string | null; to: string | null; reason: string | null }) => [e.from, e.to, e.reason])).toEqual([
      [null, null, null], ["received", "pending", "Fictional: unreadable scan"], ["pending", "received", null]]);
    expect((await call("r2a", "GET", `/api/v1/paperwork/items/${item}/history`)).statusCode).toBe(404);
    // A location role reads the placement (and its checklist) but not the paperwork history (document:read).
    expect((await call("locD", "GET", `/api/v1/paperwork/items/${item}/history`)).statusCode).toBe(403);
  });

  it("links a document of the candidate; another candidate's or an unreadable restricted one is 422 invalid_document", async () => {
    const m = await placed();
    const other = await placed();
    const item = await itemId(m.id);
    const doc = (owner: { candidate?: string; placement?: string }, type = "offer_letter") => asUser(db.app, U.hr, async (c) =>
      (await c.query(`SELECT * FROM authz.create_document_upload($1, $2, $3, 'application/pdf', 1000)`,
        [owner.candidate ?? null, owner.placement ?? null, type])).rows[0].document_id as string, true);
    let res = await call("r1a", "PATCH", `/api/v1/paperwork/items/${item}`, { documentId: await doc({ placement: other.id }) });
    expect([res.statusCode, res.json().detail]).toEqual([422, "invalid_document"]);
    res = await call("r1a", "PATCH", `/api/v1/paperwork/items/${item}`, { documentId: await doc({ candidate: m.cand.id }, "i9") });
    expect([res.statusCode, res.json().detail]).toEqual([422, "invalid_document"]);
    const mine = await doc({ placement: m.id });
    res = await call("r1a", "PATCH", `/api/v1/paperwork/items/${item}`, { documentId: mine });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().documentId).toBe(mine);
    expect((await auditOf(item)).at(-1)!.changes).toMatchObject({ fields: ["document"], documentId: mine });
  });

  it("refuses an empty change, unknown keys and a backed-out placement", async () => {
    const m = await placed();
    const item = await itemId(m.id);
    expect((await call("hr", "PATCH", `/api/v1/paperwork/items/${item}`, {})).statusCode).toBe(422);
    expect((await call("hr", "PATCH", `/api/v1/paperwork/items/${item}`, { reason: "x" })).statusCode).toBe(422);
    await transitionPlacement(db, U.r1a, m.id, "backout", "Fictional: declined");
    const res = await call("hr", "PATCH", `/api/v1/paperwork/items/${item}`, { status: "received" });
    expect([res.statusCode, res.json().detail]).toEqual([422, "placement_closed"]);
    expect((await call("hr", "PATCH", `/api/v1/paperwork/items/00000000-0000-4000-8000-000000000999`, { status: "received" })).statusCode).toBe(404);
  });

  it("the placement drawer shows progress without notes; BGC only under document:read", async () => {
    const m = await placed();
    await call("hr", "PATCH", `/api/v1/paperwork/items/${await itemId(m.id)}`, { status: "received", notes: "Fictional note", dueOn: "2020-01-03" });
    const hr = (await call("hr", "GET", `/api/v1/placements/${m.id}`)).json();
    expect(hr.checklist[0]).toEqual({ id: expect.any(String), docType: "sample_doc_a", ownerRole: "hr", required: true, status: "received",
      dueOn: "2020-01-03", overdue: true });
    expect(hr.bgc).toEqual({ status: "not_started", actions: { transition: ["initiated"] } });
    expect(JSON.stringify(hr)).not.toContain("Fictional note");
    const loc = (await call("locD", "GET", `/api/v1/placements/${m.id}`)).json();
    expect(loc.checklist).toHaveLength(3);
    expect("bgc" in loc).toBe(false);
  });
});

describe("BGC", () => {
  it("B-03: a supplied expectedVersion is enforced (409 version_mismatch, nothing changes); omitted it is last-write-wins", async () => {
    const m = await placed();
    const url = `/api/v1/paperwork/placements/${m.id}/bgc`;
    let res = await call("hr", "PATCH", url, { status: "initiated" });
    expect(res.statusCode, res.body).toBe(200);
    const v = res.json().version as number;
    expect((await call("hr", "PATCH", url, { notes: "Fictional first note", expectedVersion: v })).json().version).toBe(v + 1);
    res = await call("hr", "PATCH", url, { notes: "Fictional stale note", expectedVersion: v });
    expect([res.statusCode, res.json().detail]).toEqual([409, "version_mismatch"]);
    expect((await call("hr", "GET", `/api/v1/paperwork/placements/${m.id}`)).json().bgc).toMatchObject({ notes: "Fictional first note", version: v + 1 });
    expect((await call("hr", "PATCH", url, { notes: "Fictional last write" })).json().version).toBe(v + 2);

    // History rows: a stale delete keeps the row.
    const base = `${url}/entries`;
    res = await call("hr", "POST", base, { kind: "address", city: "Fictional City", region: "TX", country: "US", startMonth: "2021-01" });
    expect(res.statusCode, res.body).toBe(201);
    const entry = res.json().addresses[0] as { id: string; version: number };
    expect((await call("hr", "PATCH", `${base}/${entry.id}`, { verification: "verified", expectedVersion: entry.version })).statusCode).toBe(200);
    res = await call("hr", "DELETE", `${base}/${entry.id}?expectedVersion=${entry.version}`);
    expect([res.statusCode, res.json().detail]).toEqual([409, "version_mismatch"]);
    expect((await call("hr", "GET", `/api/v1/paperwork/placements/${m.id}`)).json().bgc.addresses).toHaveLength(1);
  });

  it("a cleared check is re-initiated with a reason; the drawer offers it", async () => {
    const m = await placed();
    const url = `/api/v1/paperwork/placements/${m.id}/bgc`;
    await call("hr", "PATCH", url, { status: "initiated" });
    expect((await call("hr", "PATCH", url, { status: "cleared" })).json().detail).toBe("actual_start_required");
    expect((await call("hr", "PATCH", url, { status: "cleared", actualStart: null })).statusCode).toBe(422);
    const cl = await call("hr", "PATCH", url, { status: "cleared", actualStart: "2026-12-01" });
    expect(cl.statusCode, cl.body).toBe(200);
    expect((await call("hr", "GET", `/api/v1/paperwork/placements/${m.id}`)).json().placement).toMatchObject({ actualStart: "2026-12-01" });
    expect((await call("hr", "GET", `/api/v1/placements/${m.id}`)).json()).toMatchObject({ actualStart: "2026-12-01" });
    expect((await call("hr", "GET", `/api/v1/placements/${m.id}`)).json().bgc).toEqual({ status: "cleared", actions: { transition: ["initiated", "failed"] } });
    expect((await call("hr", "PATCH", url, { status: "initiated" })).json().detail).toBe("reason_required");
    const res = await call("hr", "PATCH", url, { status: "initiated", reason: "Vendor asked for more documents" });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ status: "initiated", actions: { transition: ["in_progress", "cleared", "failed"] } });
  });

  it("HR records the check; others get 403 or 404; values and transitions are validated", async () => {
    const m = await placed();
    const url = `/api/v1/paperwork/placements/${m.id}/bgc`;
    // Manager (bgc:update over their hierarchy) edits the details too.
    const pm = await placed();
    const mi = await call("m1", "PATCH", `/api/v1/paperwork/placements/${pm.id}/bgc`, { status: "initiated", notes: "Fictional" });
    expect(mi.statusCode, mi.body).toBe(200);
    expect(mi.json()).toMatchObject({ status: "initiated", notes: "Fictional", actions: { update: true } });
    expect((await call("l1", "PATCH", url, { notes: "Fictional" })).statusCode).toBe(403); // no bgc:update
    // completedOn and helpedBy are gone from the API.
    expect((await call("hr", "PATCH", url, { completedOn: "2026-01-20" })).statusCode).toBe(422);
    expect((await call("hr", "PATCH", url, { helpedBy: U.r1a })).statusCode).toBe(422);
    expect((await call("imm", "PATCH", url, { status: "initiated" })).statusCode).toBe(403);
    let res = await call("hr", "PATCH", url, { status: "initiated", bgcCompany: "Fictional Checks LLC", employmentYears: 7 });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ status: "initiated", bgcCompany: "Fictional Checks LLC", employmentYears: 7,
      version: 2, actions: { update: true, transition: ["in_progress", "cleared", "failed"], failPlacement: false } });
    expect(res.json().history).toHaveLength(1);
    expect((await call("hr", "PATCH", url, { status: "failed" })).json().detail).toBe("reason_required");
    expect((await call("hr", "PATCH", url, { status: "not_started" })).json().detail).toBe("invalid_transition");
    expect((await call("hr", "PATCH", url, { employmentYears: 99 })).statusCode).toBe(422);
    expect((await call("hr", "PATCH", url, { status: "cleared", failPlacement: true })).statusCode).toBe(422);
    // HR alone cannot move the placement: authz.transition_placement refuses, nothing is written.
    res = await call("hr", "PATCH", url, { status: "failed", reason: "Fictional finding", failPlacement: true });
    expect(res.statusCode).toBe(403);
    expect((await call("hr", "GET", `/api/v1/paperwork/placements/${m.id}`)).json().bgc.status).toBe("initiated");
    expect((await call("hr", "PATCH", "/api/v1/paperwork/placements/00000000-0000-4000-8000-000000000999/bgc", { status: "initiated" })).statusCode).toBe(404);
    const audit = await auditOf(m.id);
    expect(audit.filter((a) => a.action === "bgc.update").map((a) => a.changes)).toEqual([
      { fields: ["status", "bgc_company", "initiated_on", "employment_years"], from: "not_started", to: "initiated" }]);
    expect(JSON.stringify(audit)).not.toMatch(/Fictional/);
  });
});

describe("BGC history rows (PW-12, migration 0460)", () => {
  it("HR adds, edits and removes employment and address rows; scope, kinds, months and the audit are checked", async () => {
    const m = await placed();
    const base = `/api/v1/paperwork/placements/${m.id}/bgc/entries`;
    // Others: 403 without bgc:update, 404 outside document:read scope.
    const emp = { kind: "employment", employer: "Fictional Corp", title: "Analyst", startMonth: "2019-03", endMonth: "2023-07",
      notes: "Fictional employer note" };
    expect((await call("l1", "POST", base, emp)).statusCode).toBe(403);
    expect((await call("hr", "POST", "/api/v1/paperwork/placements/00000000-0000-4000-8000-000000000999/bgc/entries", emp)).statusCode).toBe(404);

    let res = await call("hr", "POST", base, emp);
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().employment).toEqual([expect.objectContaining({
      kind: "employment", employer: "Fictional Corp", title: "Analyst", startMonth: "2019-03", endMonth: "2023-07",
      verification: "pending", notes: "Fictional employer note", version: 1, street: null, city: null })]);
    const empId = res.json().employment[0].id as string;

    // Address: street optional; still there = no end month; newest first.
    res = await call("hr", "POST", base, { kind: "address", city: "Fictional City", region: "TX", country: "US", startMonth: "2021-01" });
    expect(res.statusCode, res.body).toBe(201);
    res = await call("hr", "POST", base, { kind: "address", street: "1 Fictional Way", city: "Old Town", postalCode: "00000",
      country: "US", startMonth: "2017-06", endMonth: "2020-12", verification: "verified" });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().addresses.map((a: { city: string; street: string | null }) => [a.city, a.street]))
      .toEqual([["Fictional City", null], ["Old Town", "1 Fictional Way"]]);
    const addrId = res.json().addresses[1].id as string;

    // Validation: kind fields, months, unknown and server keys.
    expect((await call("hr", "POST", base, { kind: "employment", startMonth: "2019-01" })).statusCode).toBe(422);
    expect((await call("hr", "POST", base, { kind: "address", city: "X", startMonth: "2019-01" })).statusCode).toBe(422);
    expect((await call("hr", "POST", base, { ...emp, endMonth: "2018-01" })).statusCode).toBe(422);
    expect((await call("hr", "POST", base, { ...emp, startMonth: "2019-13" })).statusCode).toBe(422);
    expect((await call("hr", "POST", base, { ...emp, street: "1 Fictional Way" })).statusCode).toBe(422);
    expect((await call("hr", "POST", base, { ...emp, version: 5 })).statusCode).toBe(422);
    expect((await call("hr", "PATCH", `${base}/${empId}`, { city: "Wrong kind" })).json().detail).toBe("invalid_change");
    expect((await call("hr", "PATCH", `${base}/${empId}`, { endMonth: "2010-01" })).json().detail).toBe("invalid_change");

    res = await call("hr", "PATCH", `${base}/${empId}`, { verification: "verified", notes: null, expectedVersion: 1 });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().employment[0]).toMatchObject({ verification: "verified", notes: null, version: 2 });
    expect((await call("hr", "PATCH", `${base}/${empId}`, { verification: "pending", expectedVersion: 1 })).statusCode).toBe(409);
    expect((await call("l1", "PATCH", `${base}/${empId}`, { verification: "pending" })).statusCode).toBe(403);
    // A row of another placement is not found through this one.
    const other = await placed();
    expect((await call("hr", "PATCH", `/api/v1/paperwork/placements/${other.id}/bgc/entries/${empId}`, { verification: "pending" })).statusCode).toBe(404);

    expect((await call("l1", "DELETE", `${base}/${addrId}`)).statusCode).toBe(403);
    res = await call("hr", "DELETE", `${base}/${addrId}?expectedVersion=1`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().addresses).toHaveLength(1);
    expect((await call("hr", "DELETE", `${base}/${addrId}`)).statusCode).toBe(404);

    // The check's history names the rows; the audit has ids, kinds and field names only (rule 5).
    const detail = (await call("hr", "GET", `/api/v1/paperwork/placements/${m.id}`)).json();
    expect(detail.bgc.history.map((e: { changed: string[] }) => e.changed[0]))
      .toEqual(["address_history", "employment_history", "address_history", "address_history", "employment_history"]);
    const audit = (await auditOf(m.id)).filter((a) => String(a.action).startsWith("bgc.entry"));
    expect(audit.map((a) => [a.action, a.changes.kind])).toEqual([
      ["bgc.entry.create", "employment"], ["bgc.entry.create", "address"], ["bgc.entry.create", "address"],
      ["bgc.entry.update", "employment"], ["bgc.entry.delete", "address"]]);
    expect(audit[3]!.changes.fields).toEqual(["verification", "notes"]);
    expect(JSON.stringify(audit)).not.toMatch(/Fictional|Old Town|00000/);

    // RLS: rows follow the check's document:read scope (a location role reads the placement, not its BGC).
    const seen = (u: string) => asUser(db.app, u, async (c) => (await c.query(
      `SELECT count(*)::int AS n FROM eureka.bgc_entry WHERE placement_id = $1`, [m.id])).rows[0].n as number);
    expect(await seen(U.hr)).toBe(2);
    expect(await seen(U.locD)).toBe(0);
  });

  it("a backed-out placement's rows can no longer change", async () => {
    const m = await placed();
    const base = `/api/v1/paperwork/placements/${m.id}/bgc/entries`;
    const res = await call("hr", "POST", base, { kind: "employment", employer: "Fictional Corp", startMonth: "2020-01" });
    expect(res.statusCode, res.body).toBe(201);
    const id = res.json().employment[0].id as string;
    await transitionPlacement(db, U.r1a, m.id, "backout", "Fictional reason");
    expect((await call("hr", "PATCH", `${base}/${id}`, { verification: "verified" })).json().detail).toBe("placement_closed");
    expect((await call("hr", "DELETE", `${base}/${id}`)).json().detail).toBe("placement_closed");
  });
});

describe("templates", () => {
  it("are listed for org-wide document readers and published by org-wide verifiers", async () => {
    for (const k of users) {
      const access = checklistTemplateAccess(toUserAccess(k));
      const res = await call(k, "GET", "/api/v1/paperwork/templates");
      expect(res.statusCode, k).toBe(access.read ? 200 : 403);
      if (access.read) expect(res.json().canPublish, k).toBe(access.publish);
    }
    const list = (await call("hr", "GET", "/api/v1/paperwork/templates")).json();
    expect(list.templates).toEqual([{ kind: "paperwork", placementType: "w2", version: 1, publishedAt: expect.any(String), publishedBy: null,
      items: [{ docType: "sample_doc_a", ownerRole: "hr", required: true }, { docType: "sample_doc_b", ownerRole: "immigration", required: true },
        { docType: "sample_doc_c", ownerRole: "accounts", required: false }] }]);
    const body = { kind: "onboarding", placementType: "1099", items: [{ docType: "sample_onboarding_a", ownerRole: "hr" }], expectedVersion: 0 };
    expect((await call("acct", "POST", "/api/v1/paperwork/templates", body)).statusCode).toBe(403);
    expect((await call("m1", "POST", "/api/v1/paperwork/templates", body)).statusCode).toBe(403);
    let res = await call("imm", "POST", "/api/v1/paperwork/templates", body);
    expect([res.statusCode, res.json()]).toEqual([201, { kind: "onboarding", placementType: "1099", version: 1 }]);
    res = await call("hr", "POST", "/api/v1/paperwork/templates", body);
    expect([res.statusCode, res.json().detail]).toEqual([409, "version_mismatch"]);
    expect((await call("hr", "POST", "/api/v1/paperwork/templates", { ...body, items: [{ docType: "Bad Type", ownerRole: "hr" }], expectedVersion: 1 })).statusCode).toBe(422);
    expect((await call("hr", "POST", "/api/v1/paperwork/templates", { ...body, items: [body.items[0], body.items[0]], expectedVersion: 1 })).statusCode).toBe(422);
    const audit = (await db.admin.query(`SELECT changes FROM eureka.audit_event WHERE action = 'checklist_template.publish'`)).rows;
    expect(audit).toEqual([{ changes: { kind: "onboarding", placementType: "1099", version: 1, itemCount: 1 } }]);
  });
});

describe("BGC failure drives the placement through its own rules (FR-PLC-06)", () => {
  it("a user holding bgc:update and placement.bgc_status:update fails both in one request", async () => {
    const m = await placed();
    // m1 (Manager over r1a) also becomes HR in this database only.
    await db.admin.query(`INSERT INTO eureka.user_role (user_id, role_key) VALUES ($1, 'hr')`, [U.m1]);
    await call("m1", "PATCH", `/api/v1/paperwork/placements/${m.id}/bgc`, { status: "initiated" });
    const detail = (await call("m1", "GET", `/api/v1/paperwork/placements/${m.id}`)).json();
    expect(detail.bgc.actions.failPlacement).toBe(true);
    const res = await call("m1", "PATCH", `/api/v1/paperwork/placements/${m.id}/bgc`,
      { status: "failed", reason: "Fictional finding", failPlacement: true });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ status: "failed", actions: { update: true, transition: [], failPlacement: false } });
    const p = (await call("m1", "GET", `/api/v1/placements/${m.id}`)).json();
    expect([p.status, p.bgc]).toEqual(["bgc_failed", { status: "failed", actions: { transition: [] } }]);
    const actions = (await auditOf(m.id)).map((a) => [a.action, a.changes]);
    expect(actions).toContainEqual(["placement.status", { from: "confirmed", to: "bgc_failed", reasonGiven: true, via: "bgc" }]);
    expect((await auditOf(m.cand.id)).map((a) => a.changes)).toContainEqual({ from: "confirmation", to: "active", via: "placement" });
  });
});

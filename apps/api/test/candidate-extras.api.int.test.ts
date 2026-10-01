import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { can, canCreateBatch, candidateVisible, resolveScope, type Permission } from "@eureka/shared";
import { createApp } from "../src/app.module.js";
import { loadConfig } from "../src/platform/config.js";
import { DUPLICATE_CHECKS_PER_MINUTE } from "../src/modules/candidates/candidates.service.js";
import { asUser, createTestDb, type TestDb } from "./db-harness.js";
import { LOC, T, TECH_ID, U, seedFixtures, toUserAccess, type FixtureCandidate } from "./fixtures.js";
import { seedPipeline } from "./pipeline-seed.js";

/** API contract for batches, the candidate timeline and the duplicate check (migration 0026). */
let db: TestDb;
let app: NestFastifyApplication;
let candidates: FixtureCandidate[];
const users = Object.keys(U) as (keyof typeof U)[];

beforeAll(async () => {
  db = await createTestDb();
  candidates = await seedFixtures(db.admin);
  await seedPipeline(db, candidates);
  const url = new URL(process.env.TEST_PG_ADMIN_URL ?? "postgres://postgres:postgres@127.0.0.1:5432");
  app = await createApp(loadConfig({
    NODE_ENV: "test", AUTH_MODE: "dev", SESSION_SECRET: "test-secret-test-secret-test-secret-123",
    DATABASE_URL: `postgres://eureka_app:eureka_app_test@${url.host}/${db.name}`,
  }));
}, 120_000);

afterAll(async () => {
  await app?.close();
  await db?.drop();
});

type Session = { cookie: string; csrf: string };
const sessions = new Map<string, Session>();
async function login(key: keyof typeof U): Promise<Session> {
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
async function call(key: keyof typeof U, method: "GET" | "POST" | "PATCH" | "PUT", url: string, payload?: unknown) {
  const s = await login(key);
  return app.inject({ method, url, payload: payload as never, headers: { cookie: s.cookie, ...(method !== "GET" ? { "x-csrf-token": s.csrf } : {}) } });
}

describe("authorization matrix additions", () => {
  const someCandidate = () => candidates[0]!.id;
  const endpoints: { name: string; perm: Permission; method: "GET" | "POST"; url: () => string; body?: unknown }[] = [
    { name: "GET /batches", perm: "candidate:read", method: "GET", url: () => "/api/v1/batches" },
    { name: "GET /candidates/:id/timeline", perm: "candidate:read", method: "GET", url: () => `/api/v1/candidates/${someCandidate()}/timeline` },
    { name: "POST /candidates/duplicate-check", perm: "candidate:create", method: "POST", url: () => "/api/v1/candidates/duplicate-check", body: {} },
  ];
  const cases = users.flatMap((u) => endpoints.map((e) => [u, e.name, e] as const));

  it.each(cases)("%s → %s", async (key, _n, e) => {
    const res = await call(key, e.method, e.url(), e.body);
    if (can(toUserAccess(key), e.perm)) expect(res.statusCode, res.body).not.toBe(403);
    else expect(res.statusCode, res.body).toBe(403);
  });

  it.each(users)("%s → POST /batches is Sales leadership only (canCreateBatch)", async (key) => {
    const res = await call(key, "POST", "/api/v1/batches", {});
    if (canCreateBatch(toUserAccess(key))) expect(res.statusCode, res.body).toBe(422);
    else expect(res.statusCode, res.body).toBe(403);
  });
});

describe("batches", () => {
  let batchId: string;

  it("a lead creates a batch; duplicates are 409 and bad input 422", async () => {
    const r = await call("l1", "POST", "/api/v1/batches", { locationId: LOC.dallas, technologyId: TECH_ID, startMonth: "2026-11", sizePlanned: 25 });
    expect(r.statusCode, r.body).toBe(201);
    batchId = r.json().id;
    const again = await call("m1", "POST", "/api/v1/batches", { locationId: LOC.dallas, technologyId: TECH_ID, startMonth: "2026-11" });
    expect([again.statusCode, again.json().detail]).toEqual([409, "batch_exists"]);
    expect((await call("l1", "POST", "/api/v1/batches", { locationId: LOC.dallas, technologyId: TECH_ID, startMonth: "2026-13" })).statusCode).toBe(422);
    expect((await call("l1", "POST", "/api/v1/batches", { locationId: LOC.dallas, technologyId: TECH_ID, startMonth: "2026-10", status: "completed" })).statusCode).toBe(422);
    const audit = await db.admin.query(`SELECT actor_id FROM eureka.audit_event WHERE action = 'batch.created' AND entity_id = $1`, [batchId]);
    expect(audit.rows).toEqual([{ actor_id: U.l1 }]);
  });

  it("lists batches with a label and the create hint", async () => {
    const lead = (await call("l1", "GET", "/api/v1/batches")).json();
    expect(lead.canCreate).toBe(true);
    expect(lead.items).toContainEqual(expect.objectContaining({
      id: batchId, label: "Java · Dallas · Nov 2026", startMonth: "2026-11", sizePlanned: 25, status: "planned",
      location: { id: LOC.dallas, name: "Dallas" }, technology: { id: TECH_ID, name: "Java" },
    }));
    const rec = (await call("r1a", "GET", "/api/v1/batches?locationId=" + LOC.austin)).json();
    expect(rec.canCreate).toBe(false);
    expect(rec.items.find((b: { id: string }) => b.id === batchId)).toBeUndefined();
  });

  it("assigns candidates on create and on edit; filters the list by batch", async () => {
    const created = await call("r1a", "POST", "/api/v1/candidates", { firstName: "Bat", lastName: "Ch", technologyId: TECH_ID, locationId: LOC.dallas, batchId });
    expect(created.statusCode, created.body).toBe(201);
    const own = candidates.find((c) => c.recruiterId === U.r1a && c.locationId === LOC.dallas && c.visibility === "team" && c.marketingStatus === "on_hold")!;
    expect((await call("r1a", "PATCH", `/api/v1/candidates/${own.id}`, { batchId })).statusCode).toBe(200);

    const profile = (await call("r1b", "GET", `/api/v1/candidates/${own.id}`)).json();
    expect(profile.batch).toEqual({ id: batchId, label: "Java · Dallas · Nov 2026" });

    const r1a = (await call("r1a", "GET", `/api/v1/candidates?batchId=${batchId}`)).json().items.map((i: { id: string }) => i.id).sort();
    expect(r1a).toEqual([created.json().id, own.id].sort());
    // Another team sees none of them: the batch filter never widens scope.
    expect((await call("r3a", "GET", `/api/v1/candidates?batchId=${batchId}`)).json().items).toEqual([]);
    const listed = (await call("l1", "GET", "/api/v1/batches")).json().items.find((b: { id: string }) => b.id === batchId);
    expect(listed.candidatesInScope).toBe(2);
    expect((await call("l3", "GET", "/api/v1/batches")).json().items.find((b: { id: string }) => b.id === batchId).candidatesInScope).toBe(0);

    expect((await call("r1a", "PATCH", `/api/v1/candidates/${own.id}`, { batchId: null })).statusCode).toBe(200);
    expect((await call("r1a", "GET", `/api/v1/candidates/${own.id}`)).json().batch).toBeNull();
  });

  it("refuses a batch at another location (422 batch_not_allowed) and a teammate's candidate (403)", async () => {
    const austin = candidates.find((c) => c.recruiterId === U.r1a && c.locationId === LOC.austin)!;
    const r = await call("r1a", "PATCH", `/api/v1/candidates/${austin.id}`, { batchId });
    expect([r.statusCode, r.json().detail]).toEqual([422, "batch_not_allowed"]);
    const mate = candidates.find((c) => c.recruiterId === U.r1b && c.locationId === LOC.dallas)!;
    expect((await call("r1a", "PATCH", `/api/v1/candidates/${mate.id}`, { batchId })).statusCode).toBe(403);
  });

  it("the Hot List has no batch filter", async () => {
    expect((await call("r1a", "GET", `/api/v1/hotlist?batchId=${batchId}`)).statusCode).toBe(422);
  });
});

describe("timeline", () => {
  it("records API actions with actor names and labels, newest first", async () => {
    const c = await call("l1", "POST", "/api/v1/candidates", { firstName: "Time", lastName: "Line", technologyId: TECH_ID, locationId: LOC.dallas });
    const id = c.json().id;
    await call("l1", "PUT", `/api/v1/candidates/${id}/visibility`, { visibility: "all_teams" });
    await call("locD", "PUT", `/api/v1/candidates/${id}/technical-rating`, { rating: 3 });
    await call("l1", "POST", `/api/v1/candidates/${id}/transition`, { to: "active" });
    const r = await call("l1", "GET", `/api/v1/candidates/${id}/timeline`);
    expect(r.statusCode).toBe(200);
    expect(r.json().items.map((e: { type: string; actor: { name: string } | null; from: string | null; to: string | null }) =>
      [e.type, e.actor?.name, e.from, e.to])).toEqual([
      ["candidate.status_changed", "l1", "in_training", "active"],
      ["candidate.rating_changed", "locD", null, "3"],
      ["candidate.visibility_changed", "l1", "team", "all_teams"],
      ["candidate.created", "l1", null, "in_training"],
    ]);
    const page1 = (await call("l1", "GET", `/api/v1/candidates/${id}/timeline?limit=3`)).json();
    expect(page1.items).toHaveLength(3);
    const page2 = (await call("l1", "GET", `/api/v1/candidates/${id}/timeline?limit=3&cursor=${page1.nextCursor}`)).json();
    expect([page2.items.map((e: { type: string }) => e.type), page2.nextCursor]).toEqual([["candidate.created"], null]);
    expect((await call("l1", "GET", `/api/v1/candidates/${id}/timeline?cursor=abc`)).statusCode).toBe(422);
  });

  // Differential: the API (engine filter) and RLS alone agree, and 404 exactly when the candidate is not readable.
  const sample = () => {
    const pick = (pred: (c: FixtureCandidate) => boolean) => candidates.find(pred)!;
    return [
      pick((c) => c.recruiterId === U.r1a && c.marketingStatus === "active" && c.visibility === "team"),
      pick((c) => c.teamId === T.t3 && c.marketingStatus === "active" && c.visibility === "all_teams"),
      pick((c) => c.teamId === T.t1 && c.recruiterId === null && c.marketingStatus === "active"),
      pick((c) => c.teamId === T.t2 && c.locationId === LOC.austin),
    ];
  };
  it.each(users)("timeline for %s = RLS rows, 404 when the candidate is not readable", async (key) => {
    const access = toUserAccess(key);
    for (const cand of sample()) {
      const res = await call(key, "GET", `/api/v1/candidates/${cand.id}/timeline?limit=200`);
      if (!can(access, "candidate:read")) { expect(res.statusCode).toBe(403); continue; }
      if (!candidateVisible(resolveScope(access, "candidate:read"), cand)) { expect(res.statusCode, cand.id).toBe(404); continue; }
      expect(res.statusCode).toBe(200);
      const rls = await asUser(db.app, access.userId, async (c) =>
        (await c.query<{ id: string }>(`SELECT id::text FROM eureka.candidate_event WHERE candidate_id = $1`, [cand.id])).rows.map((r) => r.id).sort());
      expect(res.json().items.map((e: { id: string }) => e.id).sort(), `${key} ${cand.id}`).toEqual(rls);
    }
  });
});

describe("duplicate check", () => {
  // Fixture candidate 1: team t1 (lead l1), phone +14695550001.
  const first = () => candidates[0]!;
  const base = { firstName: "Dup", lastName: "Licate", technologyId: TECH_ID, locationId: LOC.dallas };

  it("normalizes the phone before storing; refuses a number without a country code", async () => {
    const r = await call("r1a", "POST", "/api/v1/candidates", { ...base, firstName: "Norm", phone: "+1 (469) 555-7777", email: " Norm@Example.COM " });
    expect(r.statusCode, r.body).toBe(201);
    const p = await db.admin.query(`SELECT p.phone_e164, p.personal_email::text AS email FROM eureka.person p JOIN eureka.candidate c ON c.person_id = p.id WHERE c.id = $1`, [r.json().id]);
    expect(p.rows[0]).toEqual({ phone_e164: "+14695557777", email: "norm@example.com" });
    const bad = await call("r1a", "POST", "/api/v1/candidates", { ...base, phone: "469 555 7778" });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().errors[0].path).toBe("phone");
  });

  it("a likely duplicate (formatted phone of another team's candidate) is 409 with no details", async () => {
    const r = await call("r3a", "POST", "/api/v1/candidates", { ...base, phone: "+1 469-555-0001" });
    expect([r.statusCode, r.json().detail]).toEqual([409, "possible_duplicate"]);
    expect(r.body).not.toMatch(/Team Rohit|Cand1|0001/);
  });

  it("the check reveals team and contact only, and the id only to those who can read the candidate", async () => {
    const other = (await call("r3a", "POST", "/api/v1/candidates/duplicate-check", { firstName: "A", lastName: "B", phone: "+1 469 555 0001" })).json();
    expect(other).toEqual({ duplicates: [{ candidateId: null, team: "Team Rohit", contact: "l1", matchedOn: ["phone"] }] });
    const owner = (await call("r1b", "POST", "/api/v1/candidates/duplicate-check", { firstName: "A", lastName: "B", phone: "+14695550001" })).json();
    expect(owner.duplicates[0].candidateId).toBe(first().id);
    expect((await call("r1a", "POST", "/api/v1/candidates/duplicate-check", { firstName: "A", lastName: "B", phone: "+919000000001" })).json())
      .toEqual({ duplicates: [] });
    expect((await call("r1a", "POST", "/api/v1/candidates/duplicate-check", { firstName: "A", lastName: "B" })).statusCode).toBe(422);
    expect((await call("r1a", "POST", "/api/v1/candidates/duplicate-check", { firstName: "", lastName: "B", phone: "+14695550001" })).statusCode).toBe(422);
  });

  it("matches the normalized email too, and creates after an explicit confirmation", async () => {
    const r = await call("l3", "POST", "/api/v1/candidates", { ...base, email: "NORM@example.com" });
    expect(r.statusCode).toBe(409);
    const ok = await call("l3", "POST", "/api/v1/candidates", { ...base, email: "NORM@example.com", confirmDuplicate: true });
    expect(ok.statusCode, ok.body).toBe(201);
    const audit = await db.admin.query(`SELECT changes FROM eureka.audit_event WHERE action = 'candidate.created' AND entity_id = $1`, [ok.json().id]);
    expect(audit.rows[0].changes).toEqual({ duplicateConfirmed: true });
  });

  it("every check is audited without the checked values", async () => {
    const { rows } = await db.admin.query(`SELECT actor_id, changes FROM eureka.audit_event WHERE action = 'candidate.duplicate_check'`);
    expect(rows.length).toBeGreaterThanOrEqual(6);
    const text = JSON.stringify(rows.map((r) => r.changes));
    expect(text).not.toMatch(/\+1469|469|example\.com|norm/i);
    expect(rows).toContainEqual({ actor_id: U.r3a, changes: { checked: ["phone"], matches: 1 } });
  });

  it("is rate-limited per user", async () => {
    let status = 200;
    for (let i = 0; i <= DUPLICATE_CHECKS_PER_MINUTE && status === 200; i++) {
      status = (await call("m2", "POST", "/api/v1/candidates/duplicate-check", { firstName: "A", lastName: "B", phone: "+919000000002" })).statusCode;
    }
    expect(status).toBe(429);
    // Other users are unaffected.
    expect((await call("m1", "POST", "/api/v1/candidates/duplicate-check", { firstName: "A", lastName: "B", phone: "+919000000002" })).statusCode).toBe(200);
  });
});

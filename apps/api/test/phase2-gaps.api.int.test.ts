import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activityVisible, candidateVisible, ownsCandidate, resolveScope, type ActivityRef } from "@eureka/shared";
import { createApp } from "../src/app.module.js";
import { loadConfig } from "../src/platform/config.js";
import { createTestDb, type TestDb } from "./db-harness.js";
import { CLIENT_ID, LOC, T, U, seedFixtures, toUserAccess, type FixtureCandidate } from "./fixtures.js";
import { newCandidate, selectedSubmission } from "./placement-seed.js";
import { seedPipeline } from "./pipeline-seed.js";

/**
 * API checks for the Phase 2 gaps closed in migration 0035 and alongside it
 * (docs/phase2-status.md): the paperwork checklist on GET /placements/:id and
 * the profile-only candidate fields on GET /candidates/:id.
 */
let db: TestDb;
let app: NestFastifyApplication;
let candidates: FixtureCandidate[];
const SECRET = "test-secret-test-secret-test-secret-123";

const W2 = [
  { doc_type: "offer_letter", owner_role: "hr", required: true },
  { doc_type: "direct_deposit", owner_role: "accounts", required: false },
];

beforeAll(async () => {
  db = await createTestDb();
  candidates = await seedFixtures(db.admin);
  await seedPipeline(db, candidates);
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

async function call(key: Key, method: "GET" | "POST" | "PATCH", url: string, payload?: unknown, headers: Record<string, string> = {}) {
  const s = await login(key);
  return app.inject({
    method, url, payload: payload as never,
    headers: { cookie: s.cookie, ...(method !== "GET" ? { "x-csrf-token": s.csrf } : {}), ...headers },
  });
}

/** Superuser write with triggers off (test setup only). */
async function force(sql: string, params: unknown[]) {
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

describe("paperwork checklist on GET /placements/:id", () => {
  const made: (ActivityRef & { id: string; type: string })[] = [];
  let n = 0;

  beforeAll(async () => {
    const plan: { actor: Key; type: string; cand: Parameters<typeof newCandidate>[1] }[] = [
      { actor: "r1a", type: "w2", cand: { teamId: T.t1, recruiterId: U.r1a, locationId: LOC.dallas } },
      { actor: "r1b", type: "c2c", cand: { teamId: T.t1, recruiterId: U.r1b, locationId: LOC.austin } },
      { actor: "r2a", type: "w2", cand: { teamId: T.t2, recruiterId: U.r2a, locationId: LOC.austin } },
      { actor: "r3a", type: "w2", cand: { teamId: T.t3, recruiterId: U.r3a, locationId: LOC.dallas } },
    ];
    for (const { actor, type, cand } of plan) {
      const c = await newCandidate(db, cand);
      const sub = await selectedSubmission(db, U[actor], c.id);
      const res = await call(actor, "POST", "/api/v1/placements",
        { submissionId: sub, placementType: type, workMode: "remote", tentativeStart: "2031-03-03" },
        { "idempotency-key": `p2-${++n}-${Date.now()}` });
      expect(res.statusCode, res.body).toBe(201);
      const p = (await db.admin.query(`SELECT * FROM eureka.placement WHERE id = $1`, [res.json().id])).rows[0];
      made.push({ id: p.id, type, recruiterId: p.recruiter_id, teamId: p.team_id, locationId: p.location_id,
        candidate: { ...c, marketingStatus: "confirmation" } });
    }
  }, 60_000);

  it.each(users)("%s sees the checklist exactly where the placement is readable", async (key) => {
    const scope = resolveScope(toUserAccess(key), "placement:read");
    for (const m of made) {
      const res = await call(key, "GET", `/api/v1/placements/${m.id}`);
      const visible = scope !== null && activityVisible(scope, m);
      // No placement:read at all: the route guard answers 403.
      expect(res.statusCode, `${key} ${m.id}`).toBe(visible ? 200 : scope === null ? 403 : 404);
      if (!visible) continue;
      // Progress fields added by migration 0044 (no notes or reasons on the placement).
      const progress = { id: expect.any(String), dueOn: null, overdue: false };
      expect(res.json().checklist).toEqual(m.type === "w2" ? [
        { docType: "offer_letter", ownerRole: "hr", required: true, status: "pending", ...progress },
        { docType: "direct_deposit", ownerRole: "accounts", required: false, status: "pending", ...progress },
      ] : []);
      // BGC status only where document:read covers the placement (B4.4).
      expect("bgc" in res.json(), `${key} bgc`).toBe(activityVisible(resolveScope(toUserAccess(key), "document:read"), m));
    }
  });

  it("list items stay lean (no checklist)", async () => {
    const res = await call("m1", "GET", "/api/v1/placements");
    expect(res.statusCode).toBe(200);
    for (const item of res.json().items) expect("checklist" in item).toBe(false);
  });
});

describe("profile-only candidate fields on GET /candidates/:id", () => {
  beforeAll(async () => {
    for (const [i, c] of candidates.entries()) {
      await force(`UPDATE eureka.candidate SET in_person_ok = $2, marketing_email = $3, vitel_number = $4 WHERE id = $1`,
        [c.id, i % 3 === 0 ? null : i % 3 === 1, `mkt${i}@eureka-mkt.example`, `+1972555${String(i).padStart(4, "0")}`]);
    }
  }, 60_000);

  it.each(users)("%s: inPersonOk for every reader, marketing contacts only with candidate.phone:read through ownership", async (key) => {
    const access = toUserAccess(key);
    const read = resolveScope(access, "candidate:read");
    const phone = resolveScope(access, "candidate.phone:read");
    for (const [i, c] of candidates.entries()) {
      if (!candidateVisible(read, c)) continue;
      const res = await call(key, "GET", `/api/v1/candidates/${c.id}`);
      expect(res.statusCode, `${key} ${c.id}`).toBe(200);
      const j = res.json();
      expect(j.inPersonOk).toBe(i % 3 === 0 ? null : i % 3 === 1);
      const contact = phone !== null && ownsCandidate(phone, c);
      expect("marketingEmail" in j, `${key} ${c.id} marketingEmail`).toBe(contact);
      expect("vitelNumber" in j, `${key} ${c.id} vitelNumber`).toBe(contact);
      if (contact) expect([j.marketingEmail, j.vitelNumber]).toEqual([`mkt${i}@eureka-mkt.example`, `+1972555${String(i).padStart(4, "0")}`]);
    }
  });

  it("an Open-to-all-teams reader from another team gets inPersonOk but no marketing contacts", async () => {
    const c = candidates.find((x) => x.teamId === T.t3 && x.visibility === "all_teams" && x.marketingStatus === "active")!;
    const res = await call("r1a", "GET", `/api/v1/candidates/${c.id}`);
    expect(res.statusCode).toBe(200);
    expect("inPersonOk" in res.json()).toBe(true);
    expect("marketingEmail" in res.json()).toBe(false);
    expect("vitelNumber" in res.json()).toBe(false);
  });

  it("what Edit profile saves is read back, and the audit keeps no contact values", async () => {
    const c = candidates.find((x) => x.recruiterId === U.r1a && x.marketingStatus === "active")!;
    const res = await call("r1a", "PATCH", `/api/v1/candidates/${c.id}`,
      { inPersonOk: false, marketingEmail: "back@eureka-mkt.example", vitelNumber: "+19725550999" });
    expect(res.statusCode, res.body).toBe(200);
    const j = (await call("r1a", "GET", `/api/v1/candidates/${c.id}`)).json();
    expect([j.inPersonOk, j.marketingEmail, j.vitelNumber]).toEqual([false, "back@eureka-mkt.example", "+19725550999"]);
    const audit = await db.admin.query(`SELECT changes::text AS t FROM eureka.audit_event WHERE entity_id = $1`, [c.id]);
    expect(audit.rows.map((r) => r.t).join(" ")).not.toMatch(/back@|9725550999/);
  });
});

describe("interview board location filter (web Location filter)", () => {
  async function ids(key: Key, query = "") {
    const out: { id: string; location: { id: string } | null }[] = [];
    let cursor = "";
    for (;;) {
      const res = await call(key, "GET", `/api/v1/interviews?limit=200${query}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      expect(res.statusCode, res.body).toBe(200);
      out.push(...res.json().items);
      cursor = res.json().nextCursor;
      if (!cursor) return out;
    }
  }

  it("narrows to one location and partitions the caller's board", async () => {
    const all = await ids("m1");
    const dallas = await ids("m1", `&locationId=${LOC.dallas}`);
    const austin = await ids("m1", `&locationId=${LOC.austin}`);
    expect(dallas.length).toBeGreaterThan(0);
    expect(austin.length).toBeGreaterThan(0);
    expect(dallas.every((i) => i.location?.id === LOC.dallas)).toBe(true);
    expect(austin.every((i) => i.location?.id === LOC.austin)).toBe(true);
    expect([...dallas, ...austin].map((i) => i.id).sort()).toEqual(all.map((i) => i.id).sort());
  });

  it("never widens the scope: a Dallas location admin filtering on Austin sees nothing", async () => {
    expect((await ids("locD")).length).toBeGreaterThan(0);
    expect(await ids("locD", `&locationId=${LOC.austin}`)).toEqual([]);
  });
});

describe("90-day duplicate submission warning (FR-SUB, design B3)", () => {
  it("is answered yes/no and audited with the submission, without naming the earlier one", async () => {
    const c = await newCandidate(db, { teamId: T.t1, recruiterId: U.r1a, locationId: LOC.dallas });
    const first = await call("r1a", "POST", "/api/v1/submissions", { candidateId: c.id, jobTitle: "Java Developer", clientId: CLIENT_ID });
    const second = await call("l1", "POST", "/api/v1/submissions", { candidateId: c.id, jobTitle: "Java Lead", clientId: CLIENT_ID });
    expect([first.statusCode, second.statusCode]).toEqual([201, 201]);
    expect([first.json().duplicateWarning, second.json().duplicateWarning]).toEqual([false, true]);
    const audit = async (id: string) => (await db.admin.query(
      `SELECT changes FROM eureka.audit_event WHERE action = 'submission.created' AND entity_id = $1`, [id])).rows[0].changes;
    expect(await audit(first.json().id)).toEqual({ candidateId: c.id, clientId: CLIENT_ID, duplicateWarning: false });
    expect(await audit(second.json().id)).toEqual({ candidateId: c.id, clientId: CLIENT_ID, duplicateWarning: true });
    expect(JSON.stringify(await audit(second.json().id))).not.toContain(first.json().id);
  });
});

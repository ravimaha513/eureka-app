import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.module.js";
import { loadConfig } from "../src/platform/config.js";
import { asUser, createTestDb, type TestDb } from "./db-harness.js";
import { LOC, T, U, seedFixtures } from "./fixtures.js";
import { newCandidate } from "./placement-seed.js";

/**
 * Optional If-Match on single-candidate writes (docs/candidates-api.md "Optimistic
 * concurrency", audit A-02 / R-10) and the birth year under the DOB policy (A-10).
 */
let db: TestDb;
let app: NestFastifyApplication;

beforeAll(async () => {
  db = await createTestDb();
  await seedFixtures(db.admin);
  const url = new URL(process.env.TEST_PG_ADMIN_URL ?? "postgres://postgres:postgres@127.0.0.1:5432");
  app = await createApp(loadConfig({
    NODE_ENV: "test", AUTH_MODE: "dev", SESSION_SECRET: "test-secret-test-secret-test-secret-123",
    DATABASE_URL: `postgres://eureka_app:eureka_app_test@${url.host}/${db.name}`,
  }));
}, 90_000);

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
async function call(key: keyof typeof U, method: "GET" | "PUT" | "PATCH" | "POST", url: string, payload?: unknown, ifMatch?: string) {
  const s = await login(key);
  return app.inject({
    method, url, payload: payload as never,
    headers: { cookie: s.cookie, ...(method !== "GET" ? { "x-csrf-token": s.csrf } : {}), ...(ifMatch !== undefined ? { "if-match": ifMatch } : {}) },
  });
}

const fresh = () => newCandidate(db, { teamId: T.t1, recruiterId: U.r1a, locationId: LOC.dallas });
const version = async (id: string) =>
  (await db.admin.query<{ v: number }>(`SELECT row_version AS v FROM eureka.candidate WHERE id = $1`, [id])).rows[0]!.v;
const snapshot = async (id: string) => (await db.admin.query(`SELECT * FROM eureka.candidate WHERE id = $1`, [id])).rows[0];
const audits = async (id: string) =>
  (await db.admin.query<{ n: number }>(`SELECT count(*)::int AS n FROM eureka.audit_event WHERE entity_id = $1`, [id])).rows[0]!.n;

/** Each route: who may call it, and a body that changes the candidate. */
const ROUTES = [
  { name: "PATCH /candidates/:id", key: "r1a", method: "PATCH", path: "", body: { priority: "P1" } },
  { name: "PUT /candidates/:id/compliance", key: "hr", method: "PUT", path: "/compliance", body: { documentsStatus: "pending" } },
  { name: "PUT /candidates/:id/recruiter", key: "l1", method: "PUT", path: "/recruiter", body: { recruiterId: U.r1b } },
  { name: "PUT /candidates/:id/technical-rating", key: "locD", method: "PUT", path: "/technical-rating", body: { rating: 4 } },
  { name: "PUT /candidates/:id/visibility", key: "l1", method: "PUT", path: "/visibility", body: { visibility: "all_teams" } },
  { name: "POST /candidates/:id/transition", key: "r1a", method: "POST", path: "/transition", body: { to: "on_hold" }, ok: 201 },
] as const;

describe("If-Match on candidate writes", () => {
  it.each(ROUTES)("$name: a current version writes and returns the new rowVersion", async (r) => {
    const c = await fresh();
    const v = await version(c.id);
    const res = await call(r.key, r.method, `/api/v1/candidates/${c.id}${r.path}`, r.body, `"${v}"`);
    expect(res.statusCode, res.body).toBe("ok" in r ? r.ok : 200);
    expect(res.json().rowVersion).toBe(await version(c.id));
    expect(res.json().rowVersion).toBeGreaterThan(v);
  });

  it.each(ROUTES)("$name: a stale version is 412 and changes nothing", async (r) => {
    const c = await fresh();
    // Someone else saved meanwhile.
    await asUser(db.app, U.r1a, (cl) => cl.query(`UPDATE eureka.candidate SET priority = 'P3' WHERE id = $1`, [c.id]), true);
    const before = await snapshot(c.id);
    const auditsBefore = await audits(c.id);
    const res = await call(r.key, r.method, `/api/v1/candidates/${c.id}${r.path}`, r.body, `"${before.row_version - 1}"`);
    expect(res.statusCode, res.body).toBe(412);
    expect(res.json().detail).toBe("stale");
    expect(await snapshot(c.id)).toEqual(before);
    expect(await audits(c.id)).toBe(auditsBefore);
  });

  it.each(ROUTES)("$name: no header writes as before and returns the rowVersion", async (r) => {
    const c = await fresh();
    const res = await call(r.key, r.method, `/api/v1/candidates/${c.id}${r.path}`, r.body);
    expect(res.statusCode, res.body).toBe("ok" in r ? r.ok : 200);
    expect(res.json().rowVersion).toBe(await version(c.id));
  });

  it("accepts W/ and bare versions and *, refuses an unparsable header with 412", async () => {
    const c = await fresh();
    expect((await call("r1a", "PATCH", `/api/v1/candidates/${c.id}`, { priority: "P1" }, `W/"${await version(c.id)}"`)).statusCode).toBe(200);
    expect((await call("r1a", "PATCH", `/api/v1/candidates/${c.id}`, { priority: "P2" }, String(await version(c.id)))).statusCode).toBe(200);
    expect((await call("r1a", "PATCH", `/api/v1/candidates/${c.id}`, { priority: "P3" }, "*")).statusCode).toBe(200);
    expect((await call("r1a", "PATCH", `/api/v1/candidates/${c.id}`, { priority: "P1" }, "abc")).statusCode).toBe(412);
  });

  it("keeps 404 / 403 ahead of the version check", async () => {
    const other = await newCandidate(db, { teamId: T.t2, recruiterId: U.r2a, locationId: LOC.dallas });
    expect((await call("r1a", "PATCH", `/api/v1/candidates/${other.id}`, { priority: "P1" }, '"999"')).statusCode).toBe(404);
    const c = await fresh();
    expect((await call("r1a", "PUT", `/api/v1/candidates/${c.id}/visibility`, { visibility: "all_teams" }, '"999"')).statusCode).toBe(403);
  });

  it("an unchanged recruiter still checks the version and returns it", async () => {
    const c = await fresh();
    const v = await version(c.id);
    expect((await call("l1", "PUT", `/api/v1/candidates/${c.id}/recruiter`, { recruiterId: U.r1a }, `"${v + 1}"`)).statusCode).toBe(412);
    const same = await call("l1", "PUT", `/api/v1/candidates/${c.id}/recruiter`, { recruiterId: U.r1a }, `"${v}"`);
    expect(same.json()).toEqual({ id: c.id, recruiterId: U.r1a, rowVersion: v });
  });

  it("the Hot List bulk paths are unaffected (no version)", async () => {
    const c = await fresh();
    const res = await call("l1", "POST", "/api/v1/hotlist/bulk/priority", { ids: [c.id], priority: "P1" });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ succeeded: 1, failed: 0 });
  });

  it("authz.candidate_version_lock: 404 out of scope, 403 without a write permission", async () => {
    const other = await newCandidate(db, { teamId: T.t2, recruiterId: U.r2a, locationId: LOC.dallas });
    await expect(asUser(db.app, U.r1a, (cl) => cl.query(`SELECT authz.candidate_version_lock($1)`, [other.id]))).rejects.toThrow(/not_found/);
    const open = await newCandidate(db, { teamId: T.t2, recruiterId: U.r2a, locationId: LOC.dallas, visibility: "all_teams" });
    await expect(asUser(db.app, U.r1a, (cl) => cl.query(`SELECT authz.candidate_version_lock($1)`, [open.id]))).rejects.toThrow(/not_permitted/);
    const own = await fresh();
    const { rows } = await asUser(db.app, U.r1a, (cl) => cl.query<{ v: number }>(`SELECT authz.candidate_version_lock($1) AS v`, [own.id]));
    expect(rows[0]!.v).toBe(await version(own.id));
  });
});

describe("birth year follows the DOB policy (A-10)", () => {
  it("shows the year only to candidate.dob:read holders who own the candidate", async () => {
    const c = await newCandidate(db, { teamId: T.t1, recruiterId: U.r1a, locationId: LOC.dallas, visibility: "all_teams" });
    await db.admin.query(`UPDATE eureka.person SET dob_year = 1994 WHERE id = (SELECT person_id FROM eureka.candidate WHERE id = $1)`, [c.id]);
    const get = async (key: keyof typeof U) => {
      const res = await call(key, "GET", `/api/v1/candidates/${c.id}`);
      expect(res.statusCode, `${key}: ${res.body}`).toBe(200);
      return res.json().dobMasked as string | null;
    };
    expect(await get("hr")).toBe("•• / •• / 1994");
    expect(await get("imm")).toBe("•• / •• / 1994");
    expect(await get("r1a")).toBeNull(); // owner without candidate.dob:read
    expect(await get("l2")).toBeNull(); // another team, through Open to all teams
    const list = await call("r1a", "GET", `/api/v1/candidates?limit=100`);
    const item = (list.json().items as { id: string; dobMasked: string | null }[]).find((i) => i.id === c.id);
    expect(item?.dobMasked).toBeNull();
  });
});

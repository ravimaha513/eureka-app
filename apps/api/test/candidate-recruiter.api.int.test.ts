import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.module.js";
import { loadConfig } from "../src/platform/config.js";
import { createTestDb, type TestDb } from "./db-harness.js";
import { LOC, T, U, seedFixtures } from "./fixtures.js";
import { newCandidate } from "./placement-seed.js";

/** Setting a candidate's recruiter over HTTP (docs/candidates-api.md): a lead or above, within their scope. */
let db: TestDb;
let app: NestFastifyApplication;
const SECRET = "test-secret-test-secret-test-secret-123";

beforeAll(async () => {
  db = await createTestDb();
  await seedFixtures(db.admin);
  const url = new URL(process.env.TEST_PG_ADMIN_URL ?? "postgres://postgres:postgres@127.0.0.1:5432");
  app = await createApp(loadConfig({
    NODE_ENV: "test", AUTH_MODE: "dev", SESSION_SECRET: SECRET,
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

async function call(key: keyof typeof U, method: "GET" | "PUT" | "PATCH", url: string, payload?: unknown) {
  const s = await login(key);
  return app.inject({
    method, url, payload: payload as never,
    headers: { cookie: s.cookie, ...(method !== "GET" ? { "x-csrf-token": s.csrf } : {}) },
  });
}

const fresh = (recruiterId: string | null = U.r1a) => newCandidate(db, { teamId: T.t1, recruiterId, locationId: LOC.dallas });
const recruiterOf = async (id: string) =>
  (await db.admin.query<{ recruiter_id: string | null }>(`SELECT recruiter_id FROM eureka.candidate WHERE id = $1`, [id])).rows[0]!.recruiter_id;

describe("candidate recruiter", () => {
  it.each(["l1", "m1", "ad", "ceo"] as const)("%s can change, add and remove the recruiter", async (key) => {
    const c = await fresh();
    const profile = await call(key, "GET", `/api/v1/candidates/${c.id}`);
    expect(profile.json().actions.assign).toBe(true);

    const change = await call(key, "PUT", `/api/v1/candidates/${c.id}/recruiter`, { recruiterId: U.r1b });
    expect(change.statusCode, change.body).toBe(200);
    expect(await recruiterOf(c.id)).toBe(U.r1b);

    expect((await call(key, "PUT", `/api/v1/candidates/${c.id}/recruiter`, { recruiterId: null })).statusCode).toBe(200);
    expect(await recruiterOf(c.id)).toBeNull();

    expect((await call(key, "PUT", `/api/v1/candidates/${c.id}/recruiter`, { recruiterId: U.r1a })).statusCode).toBe(200);
    expect(await recruiterOf(c.id)).toBe(U.r1a);
  });

  it("a recruiter can't, even on their own candidate or through the profile update", async () => {
    const c = await fresh();
    expect((await call("r1a", "GET", `/api/v1/candidates/${c.id}`)).json().actions.assign).toBe(false);
    expect((await call("r1a", "PUT", `/api/v1/candidates/${c.id}/recruiter`, { recruiterId: U.r1b })).statusCode).toBe(403);
    expect((await call("r1a", "GET", `/api/v1/candidates/${c.id}/recruiter-options`)).statusCode).toBe(403);
    expect((await call("r1a", "PATCH", `/api/v1/candidates/${c.id}`, { recruiterId: U.r1b })).statusCode).toBe(422);
    expect(await recruiterOf(c.id)).toBe(U.r1a);
  });

  it("a lead can't touch another team's candidate", async () => {
    const c = await fresh();
    const r = await call("l2", "PUT", `/api/v1/candidates/${c.id}/recruiter`, { recruiterId: U.r2a });
    expect([403, 404]).toContain(r.statusCode);
    expect(await recruiterOf(c.id)).toBe(U.r1a);
  });

  it("offers the team's people and refuses anyone else", async () => {
    const c = await fresh();
    const opts = await call("l1", "GET", `/api/v1/candidates/${c.id}/recruiter-options`);
    expect(opts.statusCode, opts.body).toBe(200);
    const ids = (opts.json().items as { id: string }[]).map((u) => u.id);
    expect(ids).toEqual(expect.arrayContaining([U.l1, U.r1a, U.r1b]));
    expect(ids).not.toContain(U.r2a);

    const r = await call("l1", "PUT", `/api/v1/candidates/${c.id}/recruiter`, { recruiterId: U.r2a });
    expect(r.statusCode).toBe(422);
    expect(r.json().detail).toBe("invalid_recruiter");
    expect(await recruiterOf(c.id)).toBe(U.r1a);
  });

  it("audits ids only", async () => {
    const c = await fresh();
    await call("l1", "PUT", `/api/v1/candidates/${c.id}/recruiter`, { recruiterId: U.r1b });
    const { rows } = await db.admin.query<{ changes: unknown }>(
      `SELECT changes FROM eureka.audit_event WHERE action = 'candidate.recruiter' AND entity_id = $1`, [c.id]);
    expect(rows.map((r) => r.changes)).toEqual([{ fromRecruiterId: U.r1a, toRecruiterId: U.r1b }]);
  });
});

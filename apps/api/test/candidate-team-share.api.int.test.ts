import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.module.js";
import { loadConfig } from "../src/platform/config.js";
import { createTestDb, type TestDb } from "./db-harness.js";
import { LOC, T, U, seedFixtures } from "./fixtures.js";
import { newCandidate } from "./placement-seed.js";

/**
 * "Selected teams" over HTTP (migration 0240, docs/candidates-api.md CA-5): a lead
 * sees only their team's candidates on the Hot List unless one is Open to all
 * teams or shared with their team, and only owners may pick the teams.
 */
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

async function call(key: keyof typeof U, method: "GET" | "PUT" | "POST", url: string, payload?: unknown) {
  const s = await login(key);
  return app.inject({
    method, url, payload: payload as never,
    headers: { cookie: s.cookie, ...(method !== "GET" ? { "x-csrf-token": s.csrf } : {}) },
  });
}

async function fresh() {
  const c = await newCandidate(db, { teamId: T.t1, recruiterId: U.r1a, locationId: LOC.dallas });
  const name = (await db.admin.query<{ n: string }>(
    `SELECT p.first_name AS n FROM eureka.candidate c JOIN eureka.person p ON p.id = c.person_id WHERE c.id = $1`, [c.id])).rows[0]!.n;
  return { id: c.id, name };
}

const onHotlist = async (key: keyof typeof U, c: { id: string; name: string }) => {
  const res = await call(key, "GET", `/api/v1/hotlist?search=${encodeURIComponent(c.name)}`);
  expect(res.statusCode).toBe(200);
  return (res.json().items as { id: string }[]).some((x) => x.id === c.id);
};

describe("Hot List and profile with selected teams", () => {
  it("another team's lead does not see a team-only candidate", async () => {
    const c = await fresh();
    expect(await onHotlist("l2", c)).toBe(false);
    expect((await call("l2", "GET", `/api/v1/candidates/${c.id}`)).statusCode).toBe(404);
  });

  it("the picked team sees it on the Hot List and profile; others don't", async () => {
    const c = await fresh();
    const put = await call("l1", "PUT", `/api/v1/candidates/${c.id}/visibility`, { visibility: "selected_teams", teamIds: [T.t2] });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({ visibility: "selected_teams", teamIds: [T.t2] });

    expect(await onHotlist("l2", c)).toBe(true);
    expect(await onHotlist("r2a", c)).toBe(true);
    expect(await onHotlist("l3", c)).toBe(false);

    const shared = await call("l2", "GET", `/api/v1/candidates/${c.id}`);
    expect(shared.statusCode).toBe(200);
    expect(shared.json().visibility).toBe("selected_teams");
    // The picks are for owners only.
    expect(shared.json().sharedTeams).toBeUndefined();
    expect(shared.json().actions.logSubmission).toBe(true);

    const own = await call("l1", "GET", `/api/v1/candidates/${c.id}`);
    expect(own.json().sharedTeams).toEqual([{ id: T.t2, name: "Team Anjali" }]);
    expect((await call("l3", "GET", `/api/v1/candidates/${c.id}`)).statusCode).toBe(404);
  });

  it("the picked team cannot change visibility (403); an outsider gets 404", async () => {
    const c = await fresh();
    await call("l1", "PUT", `/api/v1/candidates/${c.id}/visibility`, { visibility: "selected_teams", teamIds: [T.t2] });
    expect((await call("l2", "PUT", `/api/v1/candidates/${c.id}/visibility`, { visibility: "all_teams" })).statusCode).toBe(403);
    expect((await call("l3", "PUT", `/api/v1/candidates/${c.id}/visibility`, { visibility: "all_teams" })).statusCode).toBe(404);
  });

  it("validates the picks", async () => {
    const c = await fresh();
    const url = `/api/v1/candidates/${c.id}/visibility`;
    expect((await call("l1", "PUT", url, { visibility: "selected_teams" })).statusCode).toBe(422);
    expect((await call("l1", "PUT", url, { visibility: "team", teamIds: [T.t2] })).statusCode).toBe(422);
    expect((await call("l1", "PUT", url, { visibility: "selected_teams", teamIds: [T.t1] })).statusCode).toBe(422);
  });

  it("back to team only hides it again", async () => {
    const c = await fresh();
    await call("l1", "PUT", `/api/v1/candidates/${c.id}/visibility`, { visibility: "selected_teams", teamIds: [T.t2] });
    expect((await call("l1", "PUT", `/api/v1/candidates/${c.id}/visibility`, { visibility: "team" })).statusCode).toBe(200);
    expect(await onHotlist("l2", c)).toBe(false);
  });

  it("audits ids only", async () => {
    const c = await fresh();
    await call("l1", "PUT", `/api/v1/candidates/${c.id}/visibility`, { visibility: "selected_teams", teamIds: [T.t3] });
    const rows = (await db.admin.query<{ changes: Record<string, unknown> }>(
      `SELECT changes FROM eureka.audit_event WHERE action = 'candidate.visibility' AND entity_id = $1`, [c.id])).rows;
    expect(rows.map((r) => r.changes)).toEqual([{ visibility: "selected_teams", teamIds: [T.t3] }]);
  });
});

describe("GET /candidate-share-teams", () => {
  it("lists teams for those who may set visibility only", async () => {
    const ok = await call("l1", "GET", "/api/v1/candidate-share-teams");
    expect(ok.statusCode).toBe(200);
    expect((ok.json().items as { id: string }[]).map((t) => t.id)).toEqual(expect.arrayContaining([T.t1, T.t2, T.t3]));
    expect((await call("r1a", "GET", "/api/v1/candidate-share-teams")).statusCode).toBe(403);
  });
});

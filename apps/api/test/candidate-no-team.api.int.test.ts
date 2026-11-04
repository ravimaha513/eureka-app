import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.module.js";
import { loadConfig } from "../src/platform/config.js";
import { createTestDb, type TestDb } from "./db-harness.js";
import { LOC, T, TECH_ID, U, seedFixtures } from "./fixtures.js";

/**
 * A candidate created with no team (migration 0390, docs/candidates-api.md): the creator keeps
 * them through the recruiter link, the team comes later, and no Hot List until it does.
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

async function call(key: keyof typeof U, method: "GET" | "PUT" | "POST" | "PATCH", url: string, payload?: unknown) {
  const s = await login(key);
  return app.inject({ method, url, headers: { cookie: s.cookie, "x-csrf-token": s.csrf }, ...(payload !== undefined ? { payload: payload as object } : {}) });
}

let n = 0;
const contact = () => {
  n += 1;
  return { firstName: "No", lastName: `Team${n}`, phone: `+1469555${String(1000 + n)}`, email: `no.team${n}@example.com` };
};

async function createNoTeam(key: keyof typeof U) {
  const body = { ...contact(), technologyId: TECH_ID, locationId: LOC.dallas, teamId: null };
  const res = await call(key, "POST", "/api/v1/candidates", body);
  expect(res.statusCode, res.body).toBe(201);
  return { id: res.json().id as string, body };
}

const row = async (id: string) => (await db.admin.query<{ team_id: string | null; recruiter_id: string | null }>(
  `SELECT team_id, recruiter_id FROM eureka.candidate WHERE id = $1`, [id])).rows[0]!;

describe("candidate with no team", () => {
  it("is held by the creator as recruiter, visible up their line and not to other lines", async () => {
    const { id } = await createNoTeam("m1");
    expect(await row(id)).toEqual({ team_id: null, recruiter_id: U.m1 });

    const res = await call("m1", "GET", `/api/v1/candidates/${id}`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().team).toEqual({ id: null, name: "No team yet", lead: null });
    expect(res.json().canAssignTeam).toBe(true);

    expect((await call("ad", "GET", `/api/v1/candidates/${id}`)).statusCode).toBe(200);
    expect((await call("m2", "GET", `/api/v1/candidates/${id}`)).statusCode).toBe(404);
    expect((await call("l3", "GET", `/api/v1/candidates/${id}`)).statusCode).toBe(404);

    const list = await call("m1", "GET", `/api/v1/candidates?limit=100`);
    expect(list.statusCode, list.body).toBe(200);
    expect((list.json().items as { id: string }[]).some((c) => c.id === id)).toBe(true);
  });

  it("at org scope needs no recruiter", async () => {
    const { id } = await createNoTeam("ceo");
    expect(await row(id)).toEqual({ team_id: null, recruiter_id: null });
    expect((await call("ceo", "GET", `/api/v1/candidates/${id}`)).json().canAssignTeam).toBe(true);
  });

  it("still needs candidate:create", async () => {
    const res = await call("r1a", "POST", "/api/v1/candidates", { ...contact(), technologyId: TECH_ID, locationId: LOC.dallas, teamId: null });
    expect(res.statusCode).toBe(403);
  });

  it("is still caught as a duplicate", async () => {
    const { body } = await createNoTeam("m1");
    expect((await call("m1", "POST", "/api/v1/candidates", body)).statusCode).toBe(409);
    const check = await call("l3", "POST", "/api/v1/candidates/duplicate-check", {
      firstName: body.firstName, lastName: body.lastName, phone: body.phone, email: body.email });
    expect(check.statusCode, check.body).toBeLessThan(300);
    expect(JSON.stringify(check.json())).toContain("No team yet");
  });

  it("stays off the Hot List until a team is assigned", async () => {
    const { id } = await createNoTeam("m1");
    const refused = await call("m1", "PATCH", `/api/v1/candidates/${id}/status`, { to: "active" });
    expect(refused.statusCode, refused.body).toBe(422);
    expect(refused.json().detail).toBe("team_required");

    expect((await call("m1", "PUT", `/api/v1/candidates/${id}/team`, { teamId: T.t1 })).statusCode).toBe(200);
    const ok = await call("m1", "PATCH", `/api/v1/candidates/${id}/status`, { to: "active" });
    expect(ok.statusCode, ok.body).toBe(200);
  });

  it("gets a team once, within the caller's scope, and the team's lead is told", async () => {
    const { id } = await createNoTeam("m1");
    expect((await call("m1", "PUT", `/api/v1/candidates/${id}/team`, { teamId: T.t3 })).statusCode).toBe(403);
    expect((await call("m2", "PUT", `/api/v1/candidates/${id}/team`, { teamId: T.t3 })).statusCode).toBe(404);
    expect((await call("r1a", "PUT", `/api/v1/candidates/${id}/team`, { teamId: T.t1 })).statusCode).toBe(403);

    const res = await call("m1", "PUT", `/api/v1/candidates/${id}/team`, { teamId: T.t1 });
    expect(res.statusCode, res.body).toBe(200);
    // m1 is not a member of the team, so the temporary recruiter link goes.
    expect(await row(id)).toEqual({ team_id: T.t1, recruiter_id: null });

    const profile = (await call("l1", "GET", `/api/v1/candidates/${id}`)).json();
    expect(profile.team.id).toBe(T.t1);
    expect(profile.canAssignTeam).toBe(false);

    const events = await db.admin.query(`SELECT 1 FROM eureka.outbox_event WHERE type = 'candidate.assigned' AND aggregate_id = $1`, [id]);
    expect(events.rowCount).toBe(1);

    expect((await call("m1", "PUT", `/api/v1/candidates/${id}/team`, { teamId: T.t2 })).statusCode).toBe(409);
  });

  it("keeps a recruiter who is in the team", async () => {
    const { id } = await createNoTeam("ceo");
    await db.admin.query(`UPDATE eureka.candidate SET recruiter_id = $2 WHERE id = $1`, [id, U.r1a]);
    expect((await call("ceo", "PUT", `/api/v1/candidates/${id}/team`, { teamId: T.t1 })).statusCode).toBe(200);
    expect(await row(id)).toEqual({ team_id: T.t1, recruiter_id: U.r1a });
  });

  it("the database refuses clearing a team and assigning without rights", async () => {
    const { id } = await createNoTeam("m1");
    await expect(db.admin.query(`UPDATE eureka.candidate SET team_id = $2 WHERE id = $1`, [id, T.t1])).rejects.toThrow(/reassign/);
    expect((await call("m1", "PUT", `/api/v1/candidates/${id}/team`, { teamId: T.t1 })).statusCode).toBe(200);
    await expect(db.admin.query(`UPDATE eureka.candidate SET team_id = NULL WHERE id = $1`, [id])).rejects.toThrow(/team cannot be cleared/);
  });
});

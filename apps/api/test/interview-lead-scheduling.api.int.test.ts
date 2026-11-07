import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.module.js";
import { loadConfig } from "../src/platform/config.js";
import { asUser, createTestDb, type TestDb } from "./db-harness.js";
import { LOC, T, U, seedFixtures } from "./fixtures.js";
import { newCandidate, selectedSubmission } from "./placement-seed.js";

/**
 * IS-16 (migration 0580): the Interview Lead schedules interviews on the submissions of the teams they
 * and their coaches coach (fixtures: the lead coaches t1, their coach t2), without submission:update.
 * T.t3 is coached by nobody.
 */
let db: TestDb;
let app: NestFastifyApplication;
let onT1: string;
let onT2: string;
let onT3: string;
const sessions = new Map<string, { cookie: string; csrf: string }>();

async function call(key: string, method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) {
  let s = sessions.get(key);
  if (!s) {
    const r = await app.inject({ method: "POST", url: "/api/auth/dev-login", payload: { email: `${key}@eureka.example` } });
    expect(r.statusCode, r.body).toBe(204);
    const cookie = String(r.headers["set-cookie"]).split(";")[0]!;
    const me = await app.inject({ method: "GET", url: "/api/v1/me", headers: { cookie } });
    s = { cookie, csrf: me.json<{ csrfToken: string }>().csrfToken };
    sessions.set(key, s);
  }
  return app.inject({ method, url, ...(payload === undefined ? {} : { payload: payload as object }), headers: { cookie: s.cookie, "x-csrf-token": s.csrf } });
}

async function submission(teamId: string, recruiterId: string) {
  const cand = await newCandidate(db, { teamId, recruiterId, locationId: LOC.dallas });
  return selectedSubmission(db, recruiterId, cand.id, "interview_requested");
}

const body = (submissionId: string, startsAt: string, coachId?: string) =>
  ({ submissionId, round: "R1", startsAt, durationMin: 60, ...(coachId ? { coachId } : {}) });

beforeAll(async () => {
  db = await createTestDb();
  await seedFixtures(db.admin);
  const url = new URL(process.env.TEST_PG_ADMIN_URL ?? "postgres://postgres:postgres@127.0.0.1:5432");
  app = await createApp(loadConfig({
    NODE_ENV: "test", AUTH_MODE: "dev", SESSION_SECRET: "test-secret-test-secret-test-secret-123", GOOGLE_HOSTED_DOMAIN: "eureka.example",
    DATABASE_URL: `postgres://eureka_app:eureka_app_test@${url.host}/${db.name}`,
  }));
  onT1 = await submission(T.t1, U.r1a);
  onT2 = await submission(T.t2, U.r2a);
  onT3 = await submission(T.t3, U.r3a);
}, 60_000);

afterAll(async () => {
  await app?.close();
  await db?.drop();
});

describe("Interview Lead scheduling", () => {
  it("schedules on submissions of teams they or their coaches coach, with a coach, and sees the result", async () => {
    expect((await call("il", "GET", "/api/v1/interviews/coaches")).statusCode).toBe(200);
    const a = await call("il", "POST", "/api/v1/interviews", body(onT1, "2035-03-02T15:00:00Z", U.coach));
    expect(a.statusCode, a.body).toBe(201);
    const b = await call("il", "POST", "/api/v1/interviews", { ...body(onT2, "2035-03-02T17:00:00Z"), panelIds: [U.il], leadId: U.il });
    expect(b.statusCode, b.body).toBe(201);
    const got = await call("il", "GET", `/api/v1/interviews/${a.json<{ id: string }>().id}`);
    expect(got.statusCode, got.body).toBe(200);
    const audit = await db.admin.query(`SELECT actor_id FROM eureka.audit_event WHERE action = 'interview.created' AND entity_id = $1`, [a.json<{ id: string }>().id]);
    expect(audit.rows).toEqual([{ actor_id: U.il }]);
  });

  it("cannot schedule on a team nobody in their line coaches: 404 through the API, refused by the database", async () => {
    expect((await call("il", "POST", "/api/v1/interviews", body(onT3, "2035-03-03T15:00:00Z"))).statusCode).toBe(404);
    await expect(asUser(db.app, U.il, (c) => c.query(
      `INSERT INTO eureka.interview (submission_id, round, starts_at, ends_at)
       VALUES ($1, 'R1', '2035-03-03T15:00:00Z', '2035-03-03T16:00:00Z')`, [onT3]), true)).rejects.toThrow(/row-level security/);
  });

  it("a coach still cannot schedule; sales scheduling is unchanged", async () => {
    expect((await call("coach", "POST", "/api/v1/interviews", body(onT2, "2035-03-04T15:00:00Z"))).statusCode).toBe(403);
    const r = await call("r1a", "POST", "/api/v1/interviews", body(onT1, "2035-03-04T17:00:00Z"));
    expect(r.statusCode, r.body).toBe(201);
    expect((await call("r1a", "POST", "/api/v1/interviews", body(onT3, "2035-03-04T19:00:00Z"))).statusCode).toBe(404);
  });
});

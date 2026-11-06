import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.module.js";
import { loadConfig } from "../src/platform/config.js";
import { asUser, createTestDb, type TestDb } from "./db-harness.js";
import { LOC, T, U, seedFixtures } from "./fixtures.js";
import { extraUser, newCandidate, selectedSubmission } from "./placement-seed.js";

/**
 * IS-15: a coach reads the interviews they are assigned to, whichever team those belong to. The
 * coaches here coach no team, so assignment is the only path. T.t3 is outside every coaching link
 * in the fixtures, so the Interview Lead's and the fixture coach's team paths cannot match either.
 */
let db: TestDb;
let app: NestFastifyApplication;
let lone: string;
let other: string;
let mine: string;
let notMine: string;
let unassigned: string;
const FROM = "2034-03-01T00:00:00Z", TO = "2034-03-08T00:00:00Z";
const WINDOW = `from=${encodeURIComponent(FROM)}&to=${encodeURIComponent(TO)}`;
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

/** An interview on Team t3 (recruiter r3a), with its candidate readable by neither coach. */
async function interview(coachId: string | null, startsAt: string) {
  const cand = await newCandidate(db, { teamId: T.t3, recruiterId: U.r3a, locationId: LOC.austin });
  const sub = await selectedSubmission(db, U.r3a, cand.id, "interview_requested");
  return asUser(db.app, U.r3a, async (c) => {
    const id = (await c.query<{ id: string }>(
      `INSERT INTO eureka.interview (submission_id, round, starts_at, ends_at)
       VALUES ($1, 'R1', $2::timestamptz, $2::timestamptz + interval '1 hour') RETURNING id`, [sub, startsAt])).rows[0]!.id;
    if (coachId) await c.query(`UPDATE eureka.interview SET coach_id = $2 WHERE id = $1`, [id, coachId]);
    return id;
  }, true);
}

const board = async (key: string, extra = "") => {
  const r = await call(key, "GET", `/api/v1/interviews?${WINDOW}${extra}`);
  expect(r.statusCode, r.body).toBe(200);
  return r.json<{ items: { id: string; candidate: { id: string; name: string | null }; feedbackKinds: string[]; coach: { id: string } | null }[] }>().items;
};

beforeAll(async () => {
  db = await createTestDb();
  await seedFixtures(db.admin);
  lone = (await extraUser(db, "lonecoach", "interview_coach")).id;
  other = (await extraUser(db, "othercoach", "interview_coach")).id;
  const url = new URL(process.env.TEST_PG_ADMIN_URL ?? "postgres://postgres:postgres@127.0.0.1:5432");
  app = await createApp(loadConfig({
    NODE_ENV: "test", AUTH_MODE: "dev", SESSION_SECRET: "test-secret-test-secret-test-secret-123", GOOGLE_HOSTED_DOMAIN: "eureka.example",
    DATABASE_URL: `postgres://eureka_app:eureka_app_test@${url.host}/${db.name}`,
  }));
  mine = await interview(lone, "2034-03-02T15:00:00Z");
  notMine = await interview(other, "2034-03-02T17:00:00Z");
  unassigned = await interview(null, "2034-03-02T19:00:00Z");
}, 60_000);

afterAll(async () => {
  await app?.close();
  await db?.drop();
});

describe("coach assigned to an interview outside their coached teams", () => {
  it("sees it on the board with the candidate's name, and nothing else on that team", async () => {
    const items = await board("lonecoach");
    expect(items.map((i) => i.id)).toEqual([mine]);
    expect(items[0]!.candidate.name).toBeTruthy();
    expect(items[0]!.coach?.id).toBe(lone);
  });

  it("opens it; another coach's and an unassigned interview stay 404", async () => {
    expect((await call("lonecoach", "GET", `/api/v1/interviews/${mine}`)).statusCode).toBe(200);
    expect((await call("lonecoach", "GET", `/api/v1/interviews/${notMine}`)).statusCode).toBe(404);
    expect((await call("lonecoach", "GET", `/api/v1/interviews/${unassigned}`)).statusCode).toBe(404);
  });

  it("finds it by candidate name, and another coach's candidate not at all", async () => {
    const [row] = await board("lonecoach");
    const first = row!.candidate.name!.split(" ")[0]!;
    expect((await board("lonecoach", `&candidate=${encodeURIComponent(first)}`)).map((i) => i.id)).toEqual([mine]);
    const theirs = (await board("othercoach"))[0]!.candidate.name!;
    // Fixture candidates can share a first name; the full name of the other candidate is what must not match.
    expect((await board("lonecoach", `&candidate=${encodeURIComponent(theirs)}`)).map((i) => i.id).filter((id) => id !== mine)).toEqual([]);
  });

  it("the database agrees: RLS shows the assigned row only", async () => {
    const ids = await asUser(db.app, lone, async (c) =>
      (await c.query<{ id: string }>(`SELECT id FROM eureka.interview WHERE id = ANY($1::uuid[])`, [[mine, notMine, unassigned]])).rows.map((r) => r.id));
    expect(ids).toEqual([mine]);
  });

  it("can leave coach feedback on it and read it back, but not on another coach's", async () => {
    expect((await board("lonecoach"))[0]!.feedbackKinds).toEqual(["coach"]);
    const ok = await call("lonecoach", "POST", `/api/v1/interviews/${mine}/feedback`, { rating: 4, notes: "Prepared well" });
    expect(ok.statusCode, ok.body).toBe(201);
    expect(ok.json<{ kind: string }>().kind).toBe("coach");
    const read = await call("lonecoach", "GET", `/api/v1/interviews/${mine}/feedback`);
    expect(read.json<{ items: unknown[] }>().items).toHaveLength(1);
    expect((await call("lonecoach", "POST", `/api/v1/interviews/${notMine}/feedback`, { rating: 4, notes: "x" })).statusCode).toBe(404);
  });

  it("the database refuses feedback on another coach's interview directly", async () => {
    await expect(asUser(db.app, lone, (c) => c.query(
      `INSERT INTO eureka.interview_feedback (interview_id, author_id, kind, rating) VALUES ($1, $2, 'coach', 3)`, [notMine, lone]))).rejects.toThrow();
  });

  it("every interview in their calendar column opens", async () => {
    const r = await call("lonecoach", "GET", `/api/v1/coach-calendar?${WINDOW}`);
    expect(r.statusCode, r.body).toBe(200);
    const events = r.json<{ coaches: { id: string }[]; events: { coachId: string; interviewId: string; candidateName: string }[] }>();
    expect(events.coaches.map((c) => c.id)).toEqual([lone]);
    expect(events.events.map((e) => e.interviewId)).toEqual([mine]);
    expect((await call("lonecoach", "GET", `/api/v1/interviews/${events.events[0]!.interviewId}`)).statusCode).toBe(200);
  });

  it("loses it when reassigned", async () => {
    const moved = await interview(lone, "2034-03-03T15:00:00Z");
    expect((await call("lonecoach", "GET", `/api/v1/interviews/${moved}`)).statusCode).toBe(200);
    await asUser(db.app, U.r3a, (c) => c.query(`UPDATE eureka.interview SET coach_id = $2 WHERE id = $1`, [moved, other]), true);
    expect((await call("lonecoach", "GET", `/api/v1/interviews/${moved}`)).statusCode).toBe(404);
    expect((await call("othercoach", "GET", `/api/v1/interviews/${moved}`)).statusCode).toBe(200);
    await asUser(db.app, U.r3a, (c) => c.query(`UPDATE eureka.interview SET coach_id = NULL WHERE id = $1`, [moved]), true);
  });

  it("gets no edit rights from it", async () => {
    expect((await call("lonecoach", "PATCH", `/api/v1/interviews/${mine}`, { round: "R2" })).statusCode).toBe(403);
  });
});

describe("the reach of the assignment path", () => {
  it("an Interview Lead sees what a coach below them is assigned to, but not other coaches'", async () => {
    const belowLead = await interview(U.coach, "2034-03-04T15:00:00Z");
    const ids = (await board("il")).map((i) => i.id);
    expect(ids).toContain(belowLead);
    expect(ids).not.toContain(mine);
    await asUser(db.app, U.r3a, (c) => c.query(`UPDATE eureka.interview SET coach_id = NULL WHERE id = $1`, [belowLead]), true);
  });

  it("an Interview Lead may add coach feedback on a coach below them, not on another coach's", async () => {
    const below = await interview(U.coach, "2034-03-05T15:00:00Z");
    const ok = await call("il", "POST", `/api/v1/interviews/${below}/feedback`, { rating: 3, notes: "Lead review" });
    expect(ok.statusCode, ok.body).toBe(201);
    expect((await call("il", "POST", `/api/v1/interviews/${mine}/feedback`, { rating: 3, notes: "x" })).statusCode).toBe(404);
    await asUser(db.app, U.r3a, (c) => c.query(`UPDATE eureka.interview SET coach_id = NULL WHERE id = $1`, [below]), true);
  });

  it("gives the name only: the candidate record stays 404", async () => {
    const candidateId = (await board("lonecoach"))[0]!.candidate.id;
    expect((await call("lonecoach", "GET", `/api/v1/candidates/${candidateId}`)).statusCode).toBe(404);
  });

  it("ends with the coach role", async () => {
    const leaver = await extraUser(db, "leavercoach", "interview_coach");
    const iv = await interview(leaver.id, "2034-03-06T15:00:00Z");
    expect((await call("leavercoach", "GET", `/api/v1/interviews/${iv}`)).statusCode).toBe(200);
    await db.admin.query(`DELETE FROM eureka.user_role WHERE user_id = $1`, [leaver.id]);
    const seen = await asUser(db.app, leaver.id, async (c) =>
      (await c.query(`SELECT 1 FROM eureka.interview WHERE id = $1`, [iv])).rowCount);
    expect(seen).toBe(0);
  });

  it("a recruiter on another team gains nothing", async () => {
    expect((await call("r1a", "GET", `/api/v1/interviews/${mine}`)).statusCode).toBe(404);
  });

  it("the access explainer names the path and agrees with RLS", async () => {
    const r = await call("admin", "GET", `/api/v1/admin/access-explain?userId=${lone}&kind=interview&id=${mine}`);
    expect(r.statusCode, r.body).toBe(200);
    const e = r.json<{ allowed: boolean; rls: { agrees: boolean }; roles: { paths: { via: string; user?: { id: string } }[] }[] }>();
    expect(e.allowed).toBe(true);
    expect(e.rls.agrees).toBe(true);
    expect(e.roles[0]!.paths.map((p) => p.via)).toEqual(["assigned_coach"]);
    const no = await call("admin", "GET", `/api/v1/admin/access-explain?userId=${lone}&kind=interview&id=${notMine}`);
    expect(no.json<{ allowed: boolean; rls: { agrees: boolean } }>()).toMatchObject({ allowed: false, rls: { agrees: true } });
  });
});

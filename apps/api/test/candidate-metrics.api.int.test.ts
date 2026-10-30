import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.module.js";
import { loadConfig } from "../src/platform/config.js";
import { createTestDb, type TestDb } from "./db-harness.js";
import { LOC, T, U, seedFixtures } from "./fixtures.js";
import { newCandidate, selectedSubmission } from "./placement-seed.js";

/**
 * Candidate metrics (docs/candidates-api.md "Metrics"): GET /candidates/:id/metrics
 * counts submissions, interviews and placements under each one's own read scope;
 * 404 when the candidate is not readable.
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

const cookies = new Map<string, string>();
async function get(key: keyof typeof U, url: string) {
  let cookie = cookies.get(key);
  if (!cookie) {
    const res = await app.inject({ method: "POST", url: "/api/auth/dev-login", payload: { email: `${key}@eureka.example` } });
    expect(res.statusCode).toBe(204);
    cookie = String(res.headers["set-cookie"]).split(";")[0]!;
    cookies.set(key, cookie);
  }
  return app.inject({ method: "GET", url, headers: { cookie } });
}

/** Seeds rows past the guard triggers (they set server-managed columns). */
async function raw(sql: string, params: unknown[] = []) {
  const c = await db.admin.connect();
  try {
    await c.query("BEGIN");
    await c.query("SET LOCAL session_replication_role = replica");
    await c.query(sql, params);
    await c.query("COMMIT");
  } catch (err) {
    await c.query("ROLLBACK");
    throw err;
  } finally {
    c.release();
  }
}

async function interview(sub: string, round: string, hoursFromNow: number, callStatus: string, cleared = false) {
  const id = (await db.admin.query<{ id: string }>(
    `INSERT INTO eureka.interview (submission_id, round, starts_at, ends_at)
     VALUES ($1, $2, now() + make_interval(hours => $3), now() + make_interval(hours => $3 + 1)) RETURNING id`,
    [sub, round, hoursFromNow])).rows[0]!.id;
  await raw(`UPDATE eureka.interview SET call_status = $2, cleared = $3 WHERE id = $1`, [id, callStatus, cleared]);
}

describe("GET /api/v1/candidates/:id/metrics", () => {
  let cand: string;

  beforeAll(async () => {
    cand = (await newCandidate(db, { teamId: T.t1, recruiterId: U.r1a, locationId: LOC.dallas, visibility: "all_teams" })).id;
    const selected = await selectedSubmission(db, U.r1a, cand, "selected");
    const scheduled = await selectedSubmission(db, U.r1a, cand, "interview_scheduled");
    const rejected = await selectedSubmission(db, U.r1a, cand, "under_review");
    await raw(`UPDATE eureka.submission SET status = 'rejected', rejection_reason = 'Client passed' WHERE id = $1`, [rejected]);
    await interview(selected, "L1", -48, "completed", true);
    await interview(selected, "L2", -24, "completed", true);
    await interview(scheduled, "L1", -12, "completed", false);
    await interview(scheduled, "L2", 24, "scheduled");
    await interview(rejected, "L1", -72, "cancelled");
  });

  it("counts the candidate's submissions and interviews for the owning recruiter", async () => {
    const res = await get("r1a", `/api/v1/candidates/${cand}/metrics`);
    expect(res.statusCode).toBe(200);
    const m = res.json();
    expect(m.submissions).toMatchObject({
      total: 3, last30Days: 3, withInterview: 3, clients: 1,
      byStatus: { selected: 1, interview_scheduled: 1, rejected: 1 },
    });
    expect(m.interviews).toMatchObject({
      total: 5, upcoming: 1, completed: 3, cleared: 2, notCleared: 1, cancelled: 1,
      byRound: { L1: 3, L2: 2 },
    });
    expect(m.interviews.nextAt).not.toBeNull();
    // Counts only: nothing that names a client, rate or note.
    expect(JSON.stringify(m)).not.toMatch(/rate|Client passed|Java/);
  });

  it("counts nothing for another team that sees the candidate only through Open to all teams", async () => {
    const res = await get("r2a", `/api/v1/candidates/${cand}/metrics`);
    expect(res.statusCode).toBe(200);
    const m = res.json();
    if (m.submissions) expect(m.submissions.total).toBe(0);
    if (m.interviews) expect(m.interviews.total).toBe(0);
  });

  it("is 404 for a candidate the caller cannot read", async () => {
    const hidden = (await newCandidate(db, { teamId: T.t1, recruiterId: U.r1a, locationId: LOC.dallas })).id;
    expect((await get("r2a", `/api/v1/candidates/${hidden}/metrics`)).statusCode).toBe(404);
    expect((await get("r1a", `/api/v1/candidates/00000000-0000-0000-0000-0000000000ff/metrics`)).statusCode).toBe(404);
  });
});

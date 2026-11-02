import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.module.js";
import { loadConfig } from "../src/platform/config.js";
import { createTestDb, type TestDb } from "./db-harness.js";
import { LOC, T, U, seedFixtures } from "./fixtures.js";
import { newCandidate, selectedSubmission } from "./placement-seed.js";

/**
 * IS-11 "Clear and place": POST /interviews/:id/clear-and-select marks the
 * round cleared and walks its submission to selected in one transaction, so
 * POST /placements can follow.
 */
let db: TestDb;
let app: NestFastifyApplication;
const SECRET = "test-secret-test-secret-test-secret-123";

beforeAll(async () => {
  db = await createTestDb();
  await seedFixtures(db.admin);
  const url = new URL(process.env.TEST_PG_ADMIN_URL ?? "postgres://postgres:postgres@127.0.0.1:5432");
  app = await createApp(loadConfig({
    NODE_ENV: "test", AUTH_MODE: "dev", SESSION_SECRET: SECRET, GOOGLE_HOSTED_DOMAIN: "eureka.example",
    DATABASE_URL: `postgres://eureka_app:eureka_app_test@${url.host}/${db.name}`,
  }));
}, 120_000);

afterAll(async () => {
  await app?.close();
  await db?.drop();
});

type Key = keyof typeof U;
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
  return app.inject({ method, url, payload: payload as never,
    headers: { cookie: s.cookie, ...(method !== "GET" ? { "x-csrf-token": s.csrf } : {}), ...headers } });
}

let hour = 0;
/** A fresh r1a submission at `status` with one interview round. */
async function round(status = "submitted", name = "L1") {
  const cand = await newCandidate(db, { teamId: T.t1, recruiterId: U.r1a, locationId: LOC.dallas });
  const submissionId = await selectedSubmission(db, U.r1a, cand.id, status);
  const startsAt = new Date(Date.parse("2031-03-03T14:00:00Z") + hour++ * 7_200_000).toISOString();
  const iv = await call("r1a", "POST", "/api/v1/interviews", { submissionId, round: name, startsAt, durationMin: 60 });
  expect(iv.statusCode, iv.body).toBe(201);
  return { submissionId, interviewId: iv.json().id as string };
}
const clear = (key: Key, id: string) => call(key, "POST", `/api/v1/interviews/${id}/clear-and-select`);

describe("interview clear-and-select", () => {
  it("clears the round, walks the submission to selected, and a placement can follow", async () => {
    const { submissionId, interviewId } = await round("submitted");
    const res = await clear("r1a", interviewId);
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toEqual({ interviewId, result: "cleared", submissionId, submissionStatus: "selected" });

    const iv = (await call("r1a", "GET", `/api/v1/interviews/${interviewId}`)).json();
    expect(iv).toMatchObject({ result: "cleared", callStatus: "completed", submissionStatus: "selected" });
    const sub = (await call("r1a", "GET", `/api/v1/submissions/${submissionId}`)).json();
    expect(sub.status).toBe("selected");
    expect(sub.actions.createPlacement).toBe(true);

    const audit = await db.admin.query<{ changes: Record<string, unknown> }>(
      `SELECT changes FROM eureka.audit_event WHERE action = 'submission.status' AND entity_id = $1`, [submissionId]);
    expect(audit.rows.map((r) => r.changes)).toEqual([{ from: "submitted", to: "selected", viaInterview: interviewId }]);

    const placed = await call("r1a", "POST", "/api/v1/placements",
      { submissionId, placementType: "w2", workMode: "onsite", tentativeStart: "2031-04-01" }, { "idempotency-key": randomUUID() });
    expect(placed.statusCode, placed.body).toBe(201);
    expect(sub.interviews.map((t: { id: string }) => t.id)).toEqual([interviewId]);

    // The candidate is now in confirmation: a second placement may still be made from another submission.
    const candidateId = (await db.admin.query(`SELECT candidate_id FROM eureka.submission WHERE id = $1`, [submissionId])).rows[0].candidate_id;
    const other = await selectedSubmission(db, U.r1a, candidateId, "submitted");
    const otherSub = (await call("r1a", "GET", `/api/v1/submissions/${other}`)).json();
    expect(otherSub.actions).toMatchObject({ clearAndPlace: true, placeBlocked: null });
  });

  it("repeating on a selected submission is a no-op success", async () => {
    const { interviewId } = await round("interview_completed");
    expect((await clear("r1a", interviewId)).statusCode).toBe(201);
    expect((await clear("r1a", interviewId)).statusCode).toBe(201);
  });

  it("refuses when another round was rejected", async () => {
    const { submissionId, interviewId } = await round("submitted");
    const later = await call("r1a", "POST", "/api/v1/interviews",
      { submissionId, round: "L2", startsAt: new Date(Date.parse("2031-06-01T14:00:00Z")).toISOString(), durationMin: 60 });
    expect((await call("r1a", "PATCH", `/api/v1/interviews/${interviewId}`, { result: "rejected" })).statusCode).toBe(200);
    const res = await clear("r1a", later.json().id);
    expect(res.statusCode).toBe(422);
    expect(res.json().detail).toBe("round_rejected");
    expect((await call("r1a", "GET", `/api/v1/submissions/${submissionId}`)).json().status).toBe("submitted");
  });

  it("refuses closed submissions and cancelled calls", async () => {
    const a = await round("submitted");
    expect((await call("r1a", "PATCH", `/api/v1/submissions/${a.submissionId}/status`, { to: "withdrawn" })).statusCode).toBe(200);
    const closed = await clear("r1a", a.interviewId);
    expect(closed.statusCode).toBe(422);
    expect(closed.json().detail).toBe("submission_closed");

    const b = await round("submitted");
    expect((await call("r1a", "PATCH", `/api/v1/interviews/${b.interviewId}`, { callStatus: "cancelled" })).statusCode).toBe(200);
    const cancelled = await clear("r1a", b.interviewId);
    expect(cancelled.statusCode).toBe(422);
    expect(cancelled.json().detail).toBe("interview_not_held");
  });

  it("refuses other teams and location-only grants, changing nothing", async () => {
    const { submissionId, interviewId } = await round("submitted");
    expect([403, 404]).toContain((await clear("r2a", interviewId)).statusCode);
    expect([403, 404]).toContain((await clear("locD", interviewId)).statusCode);
    const row = await db.admin.query(`SELECT i.result, s.status FROM eureka.interview i JOIN eureka.submission s ON s.id = i.submission_id WHERE i.id = $1`, [interviewId]);
    expect(row.rows).toEqual([{ result: "pending", status: "submitted" }]);
    expect((await clear("l1", interviewId)).statusCode).toBe(201);
    expect((await call("l1", "GET", `/api/v1/submissions/${submissionId}`)).json().status).toBe("selected");
  });
});

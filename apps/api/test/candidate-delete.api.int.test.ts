import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.module.js";
import { loadConfig } from "../src/platform/config.js";
import { asUser, createTestDb, type TestDb } from "./db-harness.js";
import { LOC, T, U, seedFixtures } from "./fixtures.js";
import { createPlacement, newCandidate, selectedSubmission } from "./placement-seed.js";

/**
 * Candidate delete (migration 0330, docs/candidates-api.md "Deleting a candidate"):
 * candidate:delete holders hard-delete a candidate in scope with everything recorded
 * about them; a placed candidate is refused; the guards stay closed outside the delete.
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

async function call(key: keyof typeof U, method: "GET" | "DELETE", url: string) {
  const s = await login(key);
  return app.inject({ method, url, headers: { cookie: s.cookie, ...(method !== "GET" ? { "x-csrf-token": s.csrf } : {}) } });
}

/** Seeds rows past the guard triggers (they set server-managed columns or require definers). */
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

const count = async (sql: string, params: unknown[]) =>
  (await db.admin.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${sql}`, params)).rows[0]!.n;

/** A team-1 candidate with a submission, interview, feedback, resume, events and a team share. */
async function seeded() {
  const c = await newCandidate(db, { teamId: T.t1, recruiterId: U.r1a, locationId: LOC.dallas });
  const person = (await db.admin.query<{ p: string }>(`SELECT person_id AS p FROM eureka.candidate WHERE id = $1`, [c.id])).rows[0]!.p;
  const sub = await selectedSubmission(db, U.r1a, c.id, "interview_scheduled");
  const iv = (await db.admin.query<{ id: string }>(
    `INSERT INTO eureka.interview (submission_id, round, starts_at, ends_at)
     VALUES ($1, 'L1', now() - interval '2 hours', now() - interval '1 hour') RETURNING id`, [sub])).rows[0]!.id;
  await db.admin.query(`INSERT INTO eureka.interview_feedback (interview_id, author_id, kind, rating) VALUES ($1, $2, 'client', 4)`, [iv, U.r1a]);
  await raw(`
    INSERT INTO eureka.resume (candidate_id, status, content_type, size_bytes, sha256_hex, version, is_current, uploaded_by,
                               upload_expires_at, scanned_at)
    VALUES ($1, 'clean', 'application/pdf', 10, repeat('a', 64), 1, true, $2, now() + interval '1 hour', now())`, [c.id, U.r1a]);
  await raw(`INSERT INTO eureka.candidate_event (candidate_id, type) VALUES ($1, 'candidate.created')`, [c.id]);
  await raw(`INSERT INTO eureka.candidate_team_share (candidate_id, team_id, shared_by) VALUES ($1, $2, $3)`, [c.id, T.t2, U.l1]);
  return { id: c.id, person, sub, iv };
}

describe("DELETE /api/v1/candidates/:id", () => {
  it("the team lead deletes the candidate and everything under it", async () => {
    const s = await seeded();
    expect(await count(`eureka.candidate_event WHERE candidate_id = $1`, [s.id])).toBeGreaterThan(0);

    const res = await call("l1", "DELETE", `/api/v1/candidates/${s.id}`);
    expect(res.statusCode).toBe(204);

    expect(await count(`eureka.candidate WHERE id = $1`, [s.id])).toBe(0);
    expect(await count(`eureka.person WHERE id = $1`, [s.person])).toBe(0);
    expect(await count(`eureka.submission WHERE id = $1`, [s.sub])).toBe(0);
    expect(await count(`eureka.interview WHERE id = $1`, [s.iv])).toBe(0);
    expect(await count(`eureka.interview_feedback WHERE interview_id = $1`, [s.iv])).toBe(0);
    expect(await count(`eureka.resume WHERE candidate_id = $1`, [s.id])).toBe(0);
    expect(await count(`eureka.candidate_event WHERE candidate_id = $1`, [s.id])).toBe(0);
    expect(await count(`eureka.candidate_team_share WHERE candidate_id = $1`, [s.id])).toBe(0);
    expect(await count(`eureka.candidate_purge`, [])).toBe(0);
    expect(await count(`eureka.audit_event WHERE action = 'candidate.delete' AND entity_id = $1 AND actor_id = $2`, [s.id, U.l1])).toBe(1);
    expect((await call("l1", "GET", `/api/v1/candidates/${s.id}`)).statusCode).toBe(404);
  });

  it("is 404 outside read scope and 403 without candidate:delete", async () => {
    const s = await seeded();
    expect((await call("l2", "DELETE", `/api/v1/candidates/${s.id}`)).statusCode).toBe(404);
    expect((await call("r1a", "DELETE", `/api/v1/candidates/${s.id}`)).statusCode).toBe(403);
    expect(await count(`eureka.candidate WHERE id = $1`, [s.id])).toBe(1);
  });

  it("managers (hierarchy) and the CEO (org) delete too", async () => {
    expect((await call("m1", "DELETE", `/api/v1/candidates/${(await seeded()).id}`)).statusCode).toBe(204);
    expect((await call("ceo", "DELETE", `/api/v1/candidates/${(await seeded()).id}`)).statusCode).toBe(204);
  });

  it("refuses a candidate with a placement (409) and keeps every row", async () => {
    const c = await newCandidate(db, { teamId: T.t1, recruiterId: U.r1a, locationId: LOC.dallas });
    const sub = await selectedSubmission(db, U.r1a, c.id);
    await createPlacement(db, U.r1a, sub);
    const res = await call("l1", "DELETE", `/api/v1/candidates/${c.id}`);
    expect(res.statusCode).toBe(409);
    expect(res.json().detail).toBe("candidate_placed");
    expect(await count(`eureka.candidate WHERE id = $1`, [c.id])).toBe(1);
    expect(await count(`eureka.submission WHERE id = $1`, [sub])).toBe(1);
  });
});

describe("guards outside a candidate delete", () => {
  it("the app role cannot open the purge marker or delete append-only rows", async () => {
    const s = await seeded();
    await expect(asUser(db.app, U.l1, (c) => c.query(
      `INSERT INTO eureka.candidate_purge (xact, pid, candidate_id) VALUES (pg_current_xact_id(), pg_backend_pid(), $1)`, [s.id])))
      .rejects.toThrow(/permission denied/);
    await expect(asUser(db.app, U.l1, (c) => c.query(`DELETE FROM eureka.candidate WHERE id = $1`, [s.id])))
      .rejects.toThrow(/permission denied/);
    // Superuser deletes still hit the guards: only authz_definer inside a delete passes.
    await expect(db.admin.query(`DELETE FROM eureka.interview_feedback WHERE interview_id = $1`, [s.iv])).rejects.toThrow(/append-only/);
    await expect(db.admin.query(`DELETE FROM eureka.candidate_event WHERE candidate_id = $1`, [s.id])).rejects.toThrow(/definer|append-only/);
  });
});

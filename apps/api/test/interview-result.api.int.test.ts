import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.module.js";
import { loadConfig } from "../src/platform/config.js";
import { asUser, createTestDb, type TestDb } from "./db-harness.js";
import { T, U, seedFixtures } from "./fixtures.js";
import { seedPipeline, type PipelineSeed } from "./pipeline-seed.js";

/**
 * Interview result (migration 0360): the round's outcome, set by Sales
 * (recruiter, team lead and above), listed under Placements → Cleared
 * interviews by team, with the Placements Team filter.
 */
let db: TestDb;
let app: NestFastifyApplication;
let seed: PipelineSeed;
const SECRET = "test-secret-test-secret-test-secret-123";

beforeAll(async () => {
  db = await createTestDb();
  const candidates = await seedFixtures(db.admin);
  seed = await seedPipeline(db, candidates);
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
async function call(key: Key, method: "GET" | "PATCH", url: string, payload?: unknown) {
  const s = await login(key);
  return app.inject({ method, url, payload: payload as never,
    headers: { cookie: s.cookie, ...(method !== "GET" ? { "x-csrf-token": s.csrf } : {}) } });
}

const interviewOf = (recruiterId: string) => seed.interviews.find((i) => i.recruiterId === recruiterId)!.id;

describe("interview result", () => {
  it("starts pending and is a Sales field (recruiter sets it; server stamps result_at)", async () => {
    const id = interviewOf(U.r1a);
    const before = await call("r1a", "GET", `/api/v1/interviews/${id}`);
    expect(before.json()).toMatchObject({ result: "pending", resultAt: null });
    expect(before.json().editableFields).toContain("result");

    const res = await call("r1a", "PATCH", `/api/v1/interviews/${id}`, { result: "cleared" });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().result).toBe("cleared");
    expect(res.json().resultAt).not.toBeNull();
    const audit = await db.admin.query<{ changes: Record<string, unknown> }>(
      `SELECT changes FROM eureka.audit_event WHERE action = 'interview.updated' AND entity_id = $1 ORDER BY seq DESC LIMIT 1`, [id]);
    expect(audit.rows[0]!.changes).toEqual({ result: "cleared" });
  });

  it("refuses other teams' recruiters and location-only grants", async () => {
    const id = interviewOf(U.r1a);
    expect([403, 404]).toContain((await call("r2a", "PATCH", `/api/v1/interviews/${id}`, { result: "rejected" })).statusCode);
    for (const k of ["locD", "locA"] as const) {
      expect([403, 404, 422]).toContain((await call(k, "PATCH", `/api/v1/interviews/${id}`, { result: "rejected" })).statusCode);
    }
    expect((await call("r1a", "PATCH", `/api/v1/interviews/${id}`, { result: "passed" })).statusCode).toBe(422);
  });

  it("the database guard: server-managed result_at and Sales-only result", async () => {
    const id = interviewOf(U.r1a);
    await expect(asUser(db.app, U.r1a, (c) => c.query(`UPDATE eureka.interview SET result_at = now() WHERE id = $1`, [id])))
      .rejects.toThrow(/server_managed_field|permission denied/);
    await expect(asUser(db.app, U.r2a, (c) => c.query(`UPDATE eureka.interview SET result = 'rejected' WHERE id = $1 RETURNING id`, [id])
      .then((r) => { if (!r.rowCount) throw new Error("not visible"); })))
      .rejects.toThrow(/field_not_permitted|not visible/);
  });

  it("back to pending clears result_at", async () => {
    const id = interviewOf(U.r2a);
    expect((await call("l2", "PATCH", `/api/v1/interviews/${id}`, { result: "cleared" })).json().result).toBe("cleared");
    const res = await call("l2", "PATCH", `/api/v1/interviews/${id}`, { result: "pending" });
    expect(res.json()).toMatchObject({ result: "pending", resultAt: null });
  });

  it("cleared list is scoped by team: lead sees own team, manager filters by team", async () => {
    await call("r2a", "PATCH", `/api/v1/interviews/${interviewOf(U.r2a)}`, { result: "cleared" });
    const mine = await call("l1", "GET", "/api/v1/interviews?result=cleared&sort=desc");
    expect(mine.statusCode, mine.body).toBe(200);
    const mineIds = mine.json().items.map((i: { team: { id: string } | null }) => i.team?.id);
    expect(mineIds.length).toBeGreaterThan(0);
    expect(new Set(mineIds)).toEqual(new Set([T.t1]));

    const all = await call("m1", "GET", "/api/v1/interviews?result=cleared");
    expect(new Set(all.json().items.map((i: { team: { id: string } }) => i.team.id))).toEqual(new Set([T.t1, T.t2]));
    const t2 = await call("m1", "GET", `/api/v1/interviews?result=cleared&teamId=${T.t2}`);
    expect(t2.json().items.every((i: { team: { id: string }; result: string }) => i.team.id === T.t2 && i.result === "cleared")).toBe(true);
  });

  it("placements teams: one team for a lead, every team in scope for a manager", async () => {
    const lead = await call("l1", "GET", "/api/v1/placements/teams");
    expect(lead.statusCode, lead.body).toBe(200);
    expect(lead.json().items.map((t: { id: string }) => t.id)).toEqual([T.t1]);
    const mgr = await call("m1", "GET", "/api/v1/placements/teams");
    expect(mgr.json().items.map((t: { id: string }) => t.id).sort()).toEqual([T.t1, T.t2].sort());
    expect((await call("m1", "GET", `/api/v1/placements?teamId=${T.t2}`)).statusCode).toBe(200);
  });
});

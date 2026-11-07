import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveScope } from "@eureka/shared";
import { createApp } from "../src/app.module.js";
import { loadConfig } from "../src/platform/config.js";
import { REPORT_BUSY_DETAIL, REPORT_BUSY_RETRY_AFTER, REPORT_TIMEOUT_MS, REPORT_TIMEOUT_RETRY_AFTER } from "../src/platform/report-executor.js";
import { createTestDb, type TestDb } from "./db-harness.js";
import { U, seedFixtures, toUserAccess } from "./fixtures.js";

/**
 * Report executor (audit R-03): heavy (org-wide) reports take one of
 * REPORT_MAX_CONCURRENT slots per API task; one more gets 503 + Retry-After at
 * once while interactive endpoints keep answering; the raised timeout is capped
 * below the gateway's 29 s and maps to 503 + Retry-After. Health is split into
 * live (no database) and ready (database ping), /api/health staying an alias.
 */
let db: TestDb;
let app: NestFastifyApplication;
const SECRET = "test-secret-test-secret-test-secret-123";
const MAX = 2;
const PERIOD = "from=2030-01-01T00:00:00.000Z&to=2030-02-01T00:00:00.000Z";

beforeAll(async () => {
  db = await createTestDb();
  await seedFixtures(db.admin);
  const url = new URL(process.env.TEST_PG_ADMIN_URL ?? "postgres://postgres:postgres@127.0.0.1:5432");
  app = await createApp(loadConfig({
    NODE_ENV: "test", AUTH_MODE: "dev", SESSION_SECRET: SECRET, REPORT_MAX_CONCURRENT: String(MAX),
    DATABASE_URL: `postgres://eureka_app:eureka_app_test@${url.host}/${db.name}`,
  }));
}, 180_000);

afterAll(async () => {
  await app?.close();
  await db?.drop();
});

type Key = keyof typeof U;
const sessions = new Map<Key, string>();
async function get(key: Key, url: string) {
  let cookie = sessions.get(key);
  if (!cookie) {
    const res = await app.inject({ method: "POST", url: "/api/auth/dev-login", payload: { email: `${key}@eureka.example` } });
    expect(res.statusCode).toBe(204);
    cookie = String(res.headers["set-cookie"]).split(";")[0]!;
    sessions.set(key, cookie);
  }
  return app.inject({ method: "GET", url, headers: { cookie } });
}

/** Org-scope dashboard callers that count submissions (their report waits on a submission lock). */
const orgKeys = (Object.keys(U) as Key[]).filter((k) => {
  const a = toUserAccess(k);
  return resolveScope(a, "report:read")?.all && resolveScope(a, "submission:read") && resolveScope(a, "dashboard:read");
});

/** Holds an ACCESS EXCLUSIVE lock on eureka.submission until release(). */
async function lockSubmissions() {
  const locker = await db.admin.connect();
  await locker.query("BEGIN");
  await locker.query("LOCK TABLE eureka.submission IN ACCESS EXCLUSIVE MODE");
  return async () => { await locker.query("ROLLBACK"); locker.release(); };
}

async function waitingOnLock(n: number) {
  for (let i = 0; i < 200; i++) {
    const { rows } = await db.admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1 AND wait_event_type = 'Lock' AND usename = 'eureka_app'`, [db.name]);
    if (rows[0]!.n >= n) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`fewer than ${n} report queries waiting on the lock`);
}

describe("report concurrency", () => {
  it("has org-scope report callers in the fixtures", () => {
    expect(orgKeys.length).toBeGreaterThanOrEqual(1); // one caller is enough: the slots are per task, not per user
  });

  it(`refuses report ${MAX + 1} with 503 + Retry-After while /me and health still answer`, async () => {
    for (const k of orgKeys) await get(k, "/api/v1/me"); // sign in first: sessions are not part of the measurement
    const release = await lockSubmissions();
    let running: Promise<Awaited<ReturnType<typeof get>>>[] = [];
    try {
      running = Array.from({ length: MAX }, (_, i) => get(orgKeys[i % orgKeys.length]!, `/api/v1/dashboard?${PERIOD}`));
      await waitingOnLock(MAX);
      const extra = await get(orgKeys[MAX % orgKeys.length]!, `/api/v1/dashboard?${PERIOD}`);
      expect(extra.statusCode, extra.body).toBe(503);
      expect(extra.headers["retry-after"]).toBe(String(REPORT_BUSY_RETRY_AFTER));
      expect(extra.json()).toMatchObject({ status: 503, detail: REPORT_BUSY_DETAIL });
      const me = await get(orgKeys[0]!, "/api/v1/me");
      expect(me.statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url: "/api/health/live" })).statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url: "/api/health/ready" })).statusCode).toBe(200);
    } finally {
      await release();
    }
    for (const r of await Promise.all(running)) expect(r.statusCode, r.body).toBe(200);
    // Slots are free again.
    expect((await get(orgKeys[0]!, `/api/v1/dashboard?${PERIOD}`)).statusCode).toBe(200);
  }, 60_000);

  it("caps an org-wide report's timeout below the gateway's 29 s and answers 503 + Retry-After", async () => {
    const release = await lockSubmissions();
    const started = Date.now();
    try {
      const res = await get(orgKeys[0]!, `/api/v1/dashboard?${PERIOD}`);
      const elapsed = Date.now() - started;
      expect(res.statusCode, res.body).toBe(503);
      expect(res.headers["retry-after"]).toBe(String(REPORT_TIMEOUT_RETRY_AFTER));
      expect(res.json()).toMatchObject({ detail: "The report took too long; narrow the period and try again" });
      expect(elapsed).toBeGreaterThanOrEqual(REPORT_TIMEOUT_MS - 1000);
      expect(elapsed).toBeLessThan(29_000);
    } finally {
      await release();
    }
  }, 60_000);
});

describe("health", () => {
  it("live, ready and the /api/health alias answer 200 without a session", async () => {
    for (const url of ["/api/health/live", "/api/health/ready", "/api/health"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode, url).toBe(200);
      expect(res.json()).toEqual({ status: "ok" });
    }
  });

  it("without a database, live stays 200 while ready and /api/health answer 503 + Retry-After", async () => {
    const down = await createApp(loadConfig({
      NODE_ENV: "test", AUTH_MODE: "dev", SESSION_SECRET: SECRET,
      DATABASE_URL: "postgres://eureka_app:eureka_app_test@127.0.0.1:1/none",
    }));
    try {
      expect((await down.inject({ method: "GET", url: "/api/health/live" })).statusCode).toBe(200);
      for (const url of ["/api/health/ready", "/api/health"]) {
        const started = Date.now();
        const res = await down.inject({ method: "GET", url });
        expect(res.statusCode, url).toBe(503);
        expect(res.headers["retry-after"]).toBe("5");
        expect(Date.now() - started).toBeLessThan(3000);
      }
    } finally {
      await down.close();
    }
  });
});

import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.module.js";
import { loadConfig } from "../src/platform/config.js";
import { createTestDb, type TestDb } from "./db-harness.js";
import { U, seedFixtures } from "./fixtures.js";

/**
 * Two API tasks on one database (R-24, audit F-06/B-09; R-25, F-03): the
 * security limits hold across both (the count is in Postgres, not per task),
 * and a session issued by one task authenticates on the other with access read
 * from current rows on every request.
 */
let db: TestDb;
let a: NestFastifyApplication;
let b: NestFastifyApplication;

beforeAll(async () => {
  process.env.EUREKA_ENVIRONMENT = "local"; // seedCatalog switches password_login on for local/staging
  db = await createTestDb();
  await seedFixtures(db.admin);
  const url = new URL(process.env.TEST_PG_ADMIN_URL ?? "postgres://postgres:postgres@127.0.0.1:5432");
  const config = () => loadConfig({
    NODE_ENV: "test", AUTH_MODE: "dev", PASSWORD_LOGIN: "on", EUREKA_ENVIRONMENT: "local",
    SESSION_SECRET: "test-secret-test-secret-test-secret-123", GOOGLE_HOSTED_DOMAIN: "eureka.example",
    DATABASE_URL: `postgres://eureka_app:eureka_app_test@${url.host}/${db.name}`,
  });
  a = await createApp(config());
  b = await createApp(config());
}, 120_000);

afterAll(async () => {
  await a?.close();
  await b?.close();
  await db?.drop();
  delete process.env.EUREKA_ENVIRONMENT;
});

async function signIn(app: NestFastifyApplication, key: keyof typeof U) {
  const res = await app.inject({ method: "POST", url: "/api/auth/dev-login", payload: { email: `${key}@eureka.example` } });
  const cookie = String(res.headers["set-cookie"]).split(";")[0]!;
  const me = await app.inject({ method: "GET", url: "/api/v1/me", headers: { cookie } });
  expect(me.statusCode, me.body).toBe(200);
  return { cookie, csrf: me.json().csrfToken as string };
}

describe("shared rate limits across two API tasks", () => {
  it("password sign-in: 30 attempts per address per 10 minutes, counted across both tasks", async () => {
    const attempt = (app: NestFastifyApplication) => app.inject({ method: "POST", url: "/api/auth/password-login",
      payload: { email: "nobody@eureka.example", password: "not-the-password-1" } });
    for (let i = 0; i < 15; i++) {
      expect((await attempt(a)).statusCode).toBe(401);
      expect((await attempt(b)).statusCode).toBe(401);
    }
    for (const app of [a, b]) {
      const r = await attempt(app);
      expect(r.statusCode).toBe(429);
      expect(r.json().detail).toBe("too_many_attempts");
    }
  });

  it("application exports: 10 per user per 10 minutes, counted across both tasks", async () => {
    const sa = await signIn(a, "hr");
    const exp = (app: NestFastifyApplication) => app.inject({ method: "POST", url: "/api/v1/applications/export",
      headers: { cookie: sa.cookie, "x-csrf-token": sa.csrf }, payload: {} });
    for (let i = 0; i < 5; i++) {
      expect((await exp(a)).statusCode).toBe(200);
      expect((await exp(b)).statusCode).toBe(200);
    }
    const r = await exp(b);
    expect(r.statusCode).toBe(429);
    expect(r.json().detail).toBe("Too many exports; try again in a few minutes");
    // Another user has their own window.
    const other = await signIn(b, "admin");
    expect((await a.inject({ method: "POST", url: "/api/v1/applications/export",
      headers: { cookie: other.cookie, "x-csrf-token": other.csrf }, payload: {} })).statusCode).not.toBe(429);
  });
});

describe("per-request authentication (authz.request_context)", () => {
  it("a session from one task works on the other; a revoked role applies on the very next request", async () => {
    const s = await signIn(a, "hr");
    const list = (app: NestFastifyApplication) => app.inject({ method: "GET", url: "/api/v1/applicants", headers: { cookie: s.cookie } });
    expect((await list(b)).statusCode).toBe(200);
    await db.admin.query(`UPDATE eureka.user_role SET valid = tstzrange(lower(valid), now()) WHERE user_id = $1 AND role_key = 'hr'`, [U.hr]);
    expect((await list(a)).statusCode).toBe(403);
    expect((await list(b)).statusCode).toBe(403);
  });

  it("a revoked session is refused on both tasks at once", async () => {
    const s = await signIn(b, "l1");
    const me = (app: NestFastifyApplication) => app.inject({ method: "GET", url: "/api/v1/me", headers: { cookie: s.cookie } });
    expect((await me(a)).statusCode).toBe(200);
    expect((await a.inject({ method: "POST", url: "/api/auth/logout", headers: { cookie: s.cookie, "x-csrf-token": s.csrf } })).statusCode)
      .toBeLessThan(300);
    expect((await me(a)).statusCode).toBe(401);
    expect((await me(b)).statusCode).toBe(401);
  });
});

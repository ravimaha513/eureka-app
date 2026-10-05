import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.module.js";
import { loadConfig } from "../src/platform/config.js";
import { createTestDb, type TestDb } from "./db-harness.js";
import { U, seedFixtures } from "./fixtures.js";

let db: TestDb;
let app: NestFastifyApplication;
const TEMP = "Temp-pass-123";
const NEW = "Brand-new-pass-456";

beforeAll(async () => {
  process.env.EUREKA_ENVIRONMENT = "local"; // seedCatalog switches password_login on for local/staging
  db = await createTestDb();
  await seedFixtures(db.admin);
  const url = new URL(process.env.TEST_PG_ADMIN_URL ?? "postgres://postgres:postgres@127.0.0.1:5432");
  app = await createApp(loadConfig({
    NODE_ENV: "test", AUTH_MODE: "dev", PASSWORD_LOGIN: "on", EUREKA_ENVIRONMENT: "local",
    SESSION_SECRET: "test-secret-test-secret-test-secret-123", GOOGLE_HOSTED_DOMAIN: "eureka.example",
    DATABASE_URL: `postgres://eureka_app:eureka_app_test@${url.host}/${db.name}`,
  }));
}, 90_000);

afterAll(async () => {
  await app?.close();
  await db?.drop();
  delete process.env.EUREKA_ENVIRONMENT;
});

const cookieOf = (res: { headers: Record<string, unknown> }) => String(res.headers["set-cookie"]).split(";")[0]!;
const csrfOf = async (cookie: string) => (await app.inject({ method: "GET", url: "/api/v1/me", headers: { cookie } })).json().csrfToken as string;
const passwordLogin = (email: string, password: string) =>
  app.inject({ method: "POST", url: "/api/auth/password-login", payload: { email, password } });

async function adminSession() {
  const res = await app.inject({ method: "POST", url: "/api/auth/dev-login", payload: { email: "admin@eureka.example" } });
  const cookie = cookieOf(res);
  return { cookie, csrf: await csrfOf(cookie) };
}

describe("password sign-in", () => {
  it("offers the password method", async () => {
    const res = await app.inject({ method: "GET", url: "/api/auth/methods" });
    expect(res.json()).toMatchObject({ password: true });
  });

  it("an admin sets a temporary password; the user must change it before anything else", async () => {
    const a = await adminSession();
    const set = await app.inject({ method: "POST", url: `/api/v1/admin/users/${U.r1a}/password`,
      headers: { cookie: a.cookie, "x-csrf-token": a.csrf }, payload: { password: TEMP } });
    expect(set.statusCode, set.body).toBe(204);

    expect((await passwordLogin("r1a@eureka.example", "wrong-password-1")).statusCode).toBe(401);
    const ok = await passwordLogin("R1A@eureka.example", TEMP);
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ mustChangePassword: true });
    const cookie = cookieOf(ok);

    const blocked = await app.inject({ method: "GET", url: "/api/v1/candidates", headers: { cookie } });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().detail ?? blocked.json().message).toMatch(/password_change_required/);
    expect((await app.inject({ method: "GET", url: "/api/v1/me", headers: { cookie } })).json().mustChangePassword).toBe(true);

    const csrf = await csrfOf(cookie);
    const hdr = { cookie, "x-csrf-token": csrf };
    expect((await app.inject({ method: "POST", url: "/api/auth/password/change", headers: hdr,
      payload: { currentPassword: "nope-nope-nope1", newPassword: NEW } })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/api/auth/password/change", headers: hdr,
      payload: { currentPassword: TEMP, newPassword: "short1" } })).statusCode).toBe(422);
    expect((await app.inject({ method: "POST", url: "/api/auth/password/change", headers: hdr,
      payload: { currentPassword: TEMP, newPassword: NEW } })).statusCode).toBe(204);

    // The same session carries on; a fresh sign-in needs the new password.
    expect((await app.inject({ method: "GET", url: "/api/v1/candidates", headers: { cookie } })).statusCode).toBe(200);
    expect((await passwordLogin("r1a@eureka.example", TEMP)).statusCode).toBe(401);
    const again = await passwordLogin("r1a@eureka.example", NEW);
    expect(again.json()).toEqual({ mustChangePassword: false });
  });

  it("step-up accepts the password and refuses a wrong one", async () => {
    const cookie = cookieOf(await passwordLogin("r1a@eureka.example", NEW));
    const hdr = { cookie, "x-csrf-token": await csrfOf(cookie) };
    expect((await app.inject({ method: "GET", url: "/api/auth/step-up", headers: { cookie } })).json()).toMatchObject({ mode: "password", active: false });
    expect((await app.inject({ method: "POST", url: "/api/auth/step-up/password", headers: hdr, payload: { password: "wrong-wrong-1" } })).statusCode).toBe(403);
    const good = await app.inject({ method: "POST", url: "/api/auth/step-up/password", headers: hdr, payload: { password: NEW } });
    expect(good.statusCode).toBe(200);
    expect(good.json()).toMatchObject({ active: true, method: "password" });
  });

  it("locks the account after repeated failures, even for the right password", async () => {
    const a = await adminSession();
    await app.inject({ method: "POST", url: `/api/v1/admin/users/${U.r1b}/password`,
      headers: { cookie: a.cookie, "x-csrf-token": a.csrf }, payload: { password: TEMP } });
    for (let i = 0; i < 5; i++) expect((await passwordLogin("r1b@eureka.example", `wrong-pass-${i}x1`)).statusCode).toBe(401);
    expect((await passwordLogin("r1b@eureka.example", TEMP)).statusCode).toBe(429);
  });

  it("an admin can not set the password of a restricted-role user or their own", async () => {
    const a = await adminSession();
    const hdr = { cookie: a.cookie, "x-csrf-token": a.csrf };
    const hr = await app.inject({ method: "POST", url: `/api/v1/admin/users/${U.hr}/password`, headers: hdr, payload: { password: TEMP } });
    expect(hr.statusCode).toBe(403);
    expect(hr.json().detail ?? hr.json().message).toMatch(/restricted_target/);
    expect((await app.inject({ method: "POST", url: `/api/v1/admin/users/${U.admin}/password`, headers: hdr, payload: { password: TEMP } })).statusCode).toBe(403);
    expect((await passwordLogin("hr@eureka.example", TEMP)).statusCode).toBe(401);
  });

  it("stores only a bcrypt hash and writes audit rows without the password", async () => {
    const h = (await db.admin.query<{ password_hash: string }>(`SELECT password_hash FROM authz.user_credential WHERE user_id = $1`, [U.r1a])).rows[0]!;
    expect(h.password_hash).toMatch(/^\$2a\$12\$/);
    expect(h.password_hash).not.toContain(NEW);
    const audit = await db.admin.query(`SELECT changes::text AS c FROM eureka.audit_event WHERE action LIKE 'auth.password%' OR action LIKE 'admin.user.password%'`);
    expect(audit.rowCount).toBeGreaterThan(3);
    for (const r of audit.rows) expect(`${r.c}`).not.toMatch(/Temp-pass|Brand-new/);
  });

  it("the database refuses everything when the policy switch is off", async () => {
    await db.admin.query(`DELETE FROM authz.policy_setting WHERE key = 'password_login'`);
    await expect(db.admin.query(`SELECT * FROM authz.password_login('r1a@eureka.example', $1, 5, 15)`, [NEW])).rejects.toThrow();
    expect((await passwordLogin("r1a@eureka.example", NEW)).statusCode).toBeGreaterThanOrEqual(400);
  });
});

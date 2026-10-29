import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.module.js";
import { loadConfig } from "../src/platform/config.js";
import { DevMailbox, MAIL_PORT } from "../src/platform/mail.js";
import { createTestDb, type TestDb } from "./db-harness.js";
import { U, seedFixtures } from "./fixtures.js";

let db: TestDb;
let app: NestFastifyApplication;
const PW = "Chosen-pass-789";

beforeAll(async () => {
  process.env.EUREKA_ENVIRONMENT = "local"; // seedCatalog switches password_login on for local/staging
  db = await createTestDb();
  await seedFixtures(db.admin);
  const url = new URL(process.env.TEST_PG_ADMIN_URL ?? "postgres://postgres:postgres@127.0.0.1:5432");
  app = await createApp(loadConfig({
    NODE_ENV: "test", AUTH_MODE: "dev", PASSWORD_LOGIN: "on", EUREKA_ENVIRONMENT: "local",
    SESSION_SECRET: "test-secret-test-secret-test-secret-123", GOOGLE_HOSTED_DOMAIN: "eureka.example",
    PUBLIC_BASE_URL: "https://eureka.test",
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
const mailbox = () => app.get<DevMailbox>(MAIL_PORT);
/** The token from the newest set-password mail to `to`. */
const tokenFor = (to: string) => {
  const m = mailbox().inbox(to)[0];
  expect(m?.subject).toBe("Set your Eureka password");
  return /https:\/\/eureka\.test\/set-password#token=([A-Za-z0-9_-]{43})/.exec(m!.text)![1]!;
};
const setup = (token: string, newPassword: string) =>
  app.inject({ method: "POST", url: "/api/auth/password/setup", payload: { token, newPassword } });

async function admin() {
  const cookie = cookieOf(await app.inject({ method: "POST", url: "/api/auth/dev-login", payload: { email: "admin@eureka.example" } }));
  return { cookie, "x-csrf-token": await csrfOf(cookie) };
}

describe("password invite", () => {
  it("an admin emails a link; the user sets a password once and is signed in", async () => {
    const hdr = await admin();
    const sent = await app.inject({ method: "POST", url: `/api/v1/admin/users/${U.r2a}/password-invite`, headers: hdr });
    expect(sent.statusCode, sent.body).toBe(204);
    const token = tokenFor("r2a@eureka.example");

    expect((await setup(token, "short1")).statusCode).toBe(422); // weak: the link stays open
    const ok = await setup(token, PW);
    expect(ok.statusCode, ok.body).toBe(200);
    const cookie = cookieOf(ok);
    const me = (await app.inject({ method: "GET", url: "/api/v1/me", headers: { cookie } })).json();
    expect(me).toMatchObject({ id: U.r2a, mustChangePassword: false });

    expect((await setup(token, "Another-pass-1")).statusCode).toBe(400); // used
    const login = await app.inject({ method: "POST", url: "/api/auth/password-login", payload: { email: "r2a@eureka.example", password: PW } });
    expect(login.json()).toEqual({ mustChangePassword: false });
  });

  it("a newer link replaces the open one; expired and unknown links are refused alike", async () => {
    const hdr = await admin();
    await app.inject({ method: "POST", url: `/api/v1/admin/users/${U.r3a}/password-invite`, headers: hdr });
    const first = tokenFor("r3a@eureka.example");
    await app.inject({ method: "POST", url: `/api/v1/admin/users/${U.r3a}/password-invite`, headers: hdr });
    const second = tokenFor("r3a@eureka.example");
    expect(second).not.toBe(first);
    expect((await setup(first, PW)).json().detail).toBe("invalid_link");

    await db.admin.query(`UPDATE authz.password_setup_token SET expires_at = now() - interval '1 minute' WHERE user_id = $1 AND used_at IS NULL`, [U.r3a]);
    expect((await setup(second, PW)).statusCode).toBe(400);
    expect((await setup("A".repeat(43), PW)).statusCode).toBe(400);
    expect((await setup("not-a-token", PW)).statusCode).toBe(400);
  });

  it("creating a user can send the invite", async () => {
    const hdr = await admin();
    const res = await app.inject({ method: "POST", url: "/api/v1/admin/users", headers: hdr,
      payload: { email: "newbie@eureka.example", displayName: "New Bie", sendPasswordInvite: true } });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({ invite: "sent" });
    expect((await setup(tokenFor("newbie@eureka.example"), PW)).statusCode).toBe(200);

    const both = await app.inject({ method: "POST", url: "/api/v1/admin/users", headers: hdr,
      payload: { email: "both@eureka.example", displayName: "Both", sendPasswordInvite: true, temporaryPassword: "Temp-pass-123" } });
    expect(both.statusCode).toBe(422);
  });

  it("refuses restricted-role users, one's own account and non-admins", async () => {
    const hdr = await admin();
    const hr = await app.inject({ method: "POST", url: `/api/v1/admin/users/${U.hr}/password-invite`, headers: hdr });
    expect(hr.statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: `/api/v1/admin/users/${U.admin}/password-invite`, headers: hdr })).statusCode).toBe(403);
    const rc = cookieOf(await app.inject({ method: "POST", url: "/api/auth/dev-login", payload: { email: "l1@eureka.example" } }));
    const lead = await app.inject({ method: "POST", url: `/api/v1/admin/users/${U.r1a}/password-invite`,
      headers: { cookie: rc, "x-csrf-token": await csrfOf(rc) } });
    expect(lead.statusCode).toBe(403);
    expect(mailbox().inbox("hr@eureka.example")).toHaveLength(0);
  });

  it("stores only token hashes and audits without tokens or emails", async () => {
    const rows = (await db.admin.query<{ h: Buffer }>(`SELECT token_hash AS h FROM authz.password_setup_token`)).rows;
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.h).toHaveLength(32);
    const audit = await db.admin.query<{ action: string; c: string }>(
      `SELECT action, changes::text AS c FROM eureka.audit_event WHERE action IN ('admin.user.password_invite', 'auth.password_setup')`);
    expect(audit.rows.map((r) => r.action)).toEqual(expect.arrayContaining(["admin.user.password_invite", "auth.password_setup"]));
    for (const r of audit.rows) expect(r.c).not.toMatch(/@|Chosen-pass|token/i);
  });
});

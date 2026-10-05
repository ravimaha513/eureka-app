import { createHash } from "node:crypto";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.module.js";
import { loadConfig } from "../src/platform/config.js";
import { GENERIC_SENT } from "../src/modules/portal/portal-auth.service.js";
import { asUser, createTestDb, type TestDb } from "./db-harness.js";
import { U, seedFixtures } from "./fixtures.js";

/** Applicant portal sign-up and one-time-link sign-in (docs/jobs-portal-api.md JP-10..JP-16, migration 0061). */
let db: TestDb;
let app: NestFastifyApplication;
const SECRET = "test-secret-test-secret-test-secret-123";
const H = { "x-eureka-portal": "1" };
let ipSeq = 10;
const nextIp = () => `10.0.0.${ipSeq++}`;

beforeAll(async () => {
  db = await createTestDb();
  await seedFixtures(db.admin);
  const url = new URL(process.env.TEST_PG_ADMIN_URL ?? "postgres://postgres:postgres@127.0.0.1:5432");
  app = await createApp(loadConfig({
    NODE_ENV: "test", AUTH_MODE: "dev", SESSION_SECRET: SECRET,
    DATABASE_URL: `postgres://eureka_app:eureka_app_test@${url.host}/${db.name}`,
  }));
}, 120_000);

afterAll(async () => {
  await app?.close();
  await db?.drop();
});

const post = (url: string, payload: unknown, headers: Record<string, string> = H, ip = nextIp()) =>
  app.inject({ method: "POST", url, payload: payload as never, headers, remoteAddress: ip });
const mailbox = async (to: string) =>
  (await app.inject({ method: "GET", url: `/api/portal/dev/mailbox?to=${encodeURIComponent(to)}` })).json().items as { subject: string; text: string }[];
const tokenOf = (text: string) => /#token=([^\s]+)/.exec(text)![1]!;

export async function signUpAndIn(email: string, first = "Rakesh") {
  const r = await post("/api/portal/auth/sign-up", { firstName: first, lastName: "Uvsn", email, phone: "+1 469 555 0101" });
  expect(r.statusCode).toBe(202);
  const token = tokenOf((await mailbox(email))[0]!.text);
  const v = await post("/api/portal/auth/verify", { token });
  expect(v.statusCode).toBe(204);
  const cookie = String(v.headers["set-cookie"]).split(";")[0]!;
  const me = await app.inject({ method: "GET", url: "/api/portal/me", headers: { cookie } });
  return { cookie, csrf: me.json().csrfToken as string, id: me.json().id as string };
}

describe("sign-up and sign-in", () => {
  it("answers the same for new, existing and unknown emails; mails only real accounts", async () => {
    const a = await post("/api/portal/auth/sign-up", { firstName: "Asha", lastName: "Iyer", email: "Asha@Example.com ", phone: "+91 98765 43210" });
    expect(a.statusCode).toBe(202);
    expect(a.json()).toEqual({ message: GENERIC_SENT });
    const again = await post("/api/portal/auth/sign-up", { firstName: "Mallory", lastName: "X", email: "asha@example.com", phone: "+1 469 555 0199" });
    expect(again.statusCode).toBe(202);
    expect(again.json()).toEqual(a.json());
    const unknown = await post("/api/portal/auth/request-link", { email: "nobody@example.com" });
    const known = await post("/api/portal/auth/request-link", { email: "asha@example.com" });
    expect(unknown.statusCode).toBe(202);
    expect(unknown.json()).toEqual(known.json());
    expect(await mailbox("nobody@example.com")).toEqual([]);
    const mails = await mailbox("asha@example.com");
    expect(mails).toHaveLength(3);
    expect(mails[2]!.subject).toBe("Confirm your email for Eureka Careers");
    expect(mails[0]!.text).toMatch(/\/portal\/verify#token=[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}/);
    // Unverified: the second sign-up replaced the name (the mailbox owner confirms by using a link).
    const row = (await db.admin.query(`SELECT first_name, phone_e164, email_verified_at FROM eureka.applicant WHERE email = 'asha@example.com'`)).rows[0];
    expect(row).toMatchObject({ first_name: "Mallory", phone_e164: "+14695550199", email_verified_at: null });
  });

  it("stores only hashes of link secrets", async () => {
    const mails = await mailbox("asha@example.com");
    const secret = tokenOf(mails[0]!.text).split(".")[1]!;
    const rows = (await db.admin.query(`SELECT secret_hash FROM eureka.applicant_login_link`)).rows;
    expect(JSON.stringify(rows)).not.toContain(secret);
    const hash = createHash("sha256").update(secret).digest();
    expect(rows.some((r) => (r.secret_hash as Buffer).equals(hash))).toBe(true);
  });

  it("a link works once, burns the other open links and sets a strict, path-scoped cookie", async () => {
    const mails = await mailbox("asha@example.com");
    const v = await post("/api/portal/auth/verify", { token: tokenOf(mails[0]!.text) });
    expect(v.statusCode).toBe(204);
    const set = String(v.headers["set-cookie"]);
    expect(set).toMatch(/^eureka_portal_sid=[A-Za-z0-9_-]{43};/);
    expect(set).toMatch(/Path=\/api\/portal/);
    expect(set).toMatch(/HttpOnly/);
    expect(set).toMatch(/SameSite=Strict/);
    expect((await post("/api/portal/auth/verify", { token: tokenOf(mails[0]!.text) })).json().detail).toBe("link_invalid");
    expect((await post("/api/portal/auth/verify", { token: tokenOf(mails[1]!.text) })).statusCode).toBe(400);
    const verified = (await db.admin.query(`SELECT email_verified_at FROM eureka.applicant WHERE email = 'asha@example.com'`)).rows[0];
    expect(verified.email_verified_at).not.toBeNull();
    // Verified now: a new sign-up for the address does not change the account.
    await post("/api/portal/auth/sign-up", { firstName: "Eve", lastName: "X", email: "asha@example.com", phone: "+1 469 555 0100" });
    expect((await db.admin.query(`SELECT first_name FROM eureka.applicant WHERE email = 'asha@example.com'`)).rows[0].first_name).toBe("Mallory");
    expect((await mailbox("asha@example.com"))[0]!.subject).toBe("Sign in to Eureka Careers");
  });

  it("refuses tampered, malformed and expired links with the same answer", async () => {
    await post("/api/portal/auth/sign-up", { firstName: "Tam", lastName: "Per", email: "tamper@example.com", phone: "+1 469 555 0102" });
    const token = tokenOf((await mailbox("tamper@example.com"))[0]!.text);
    const [id, secret] = token.split(".") as [string, string];
    const flipped = `${id}.${secret.slice(0, -1)}${secret.endsWith("A") ? "B" : "A"}`;
    for (const t of [flipped, "nope", `${id}.short`, `00000000-0000-0000-0000-000000000000.${secret}`]) {
      const r = await post("/api/portal/auth/verify", { token: t });
      expect(r.statusCode, t).toBe(400);
      expect(r.json().detail).toBe("link_invalid");
    }
    const c = await db.admin.connect();
    try {
      await c.query("SET ROLE authz_definer");
      await c.query(`UPDATE eureka.applicant_login_link SET created_at = created_at - interval '20 minutes', expires_at = now() - interval '1 second' WHERE id = $1`, [id]);
    } finally { await c.query("RESET ROLE"); c.release(); }
    expect((await post("/api/portal/auth/verify", { token })).statusCode).toBe(400);
  });

  it("needs the portal header on unauthenticated writes and validates the body", async () => {
    expect((await post("/api/portal/auth/request-link", { email: "asha@example.com" }, {})).statusCode).toBe(403);
    expect((await post("/api/portal/auth/sign-up", { firstName: "A", lastName: "B", email: "x@example.com", phone: "12345" })).statusCode).toBe(422);
    expect((await post("/api/portal/auth/sign-up", { firstName: "A", lastName: "B", email: "x@example.com", phone: "+1 469 555 0103", dob: "1990-01-01" })).statusCode).toBe(422);
    expect((await post("/api/portal/auth/request-link", { email: "not-an-email" })).statusCode).toBe(422);
  });
});

describe("rate limits", () => {
  it("per email: at most 5 links an hour, answers unchanged", async () => {
    await post("/api/portal/auth/sign-up", { firstName: "Rate", lastName: "Limit", email: "rate@example.com", phone: "+1 469 555 0104" });
    for (let i = 0; i < 7; i++) {
      const r = await post("/api/portal/auth/request-link", { email: "rate@example.com" });
      expect(r.statusCode).toBe(202);
      expect(r.json().message).toBe(GENERIC_SENT);
    }
    expect((await mailbox("rate@example.com")).length).toBe(5);
  });

  it("per client address: 429 after 20 requests in 15 minutes", async () => {
    const ip = "10.9.9.9";
    const codes: number[] = [];
    for (let i = 0; i < 21; i++) codes.push((await post("/api/portal/auth/request-link", { email: `ip${i}@example.com` }, H, ip)).statusCode);
    expect(codes.slice(0, 20).every((c) => c === 202)).toBe(true);
    expect(codes[20]).toBe(429);
  });
});

describe("session separation", () => {
  let s: { cookie: string; csrf: string; id: string };
  let staffCookie: string;
  beforeAll(async () => {
    s = await signUpAndIn("sep@example.com");
    const r = await app.inject({ method: "POST", url: "/api/auth/dev-login", payload: { email: "hr@eureka.example" } });
    staffCookie = String(r.headers["set-cookie"]).split(";")[0]!;
  });

  it("portal routes take only applicant sessions", async () => {
    const me = await app.inject({ method: "GET", url: "/api/portal/me", headers: { cookie: s.cookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ firstName: "Rakesh", email: "sep@example.com", phone: "+14695550101", emailVerified: true });
    expect((await app.inject({ method: "GET", url: "/api/portal/me", headers: { cookie: staffCookie } })).statusCode).toBe(401);
    const staffSid = staffCookie.split("=")[1]!;
    expect((await app.inject({ method: "GET", url: "/api/portal/me", headers: { cookie: `eureka_portal_sid=${staffSid}` } })).statusCode).toBe(401);
  });

  it("staff routes refuse applicant sessions", async () => {
    const sid = s.cookie.split("=")[1]!;
    for (const url of ["/api/v1/me", "/api/v1/jobs", "/api/v1/hotlist"]) {
      expect((await app.inject({ method: "GET", url, headers: { cookie: s.cookie } })).statusCode, url).toBe(401);
      expect((await app.inject({ method: "GET", url, headers: { cookie: `eureka_sid=${sid}` } })).statusCode, url).toBe(401);
    }
  });

  it("portal writes need the applicant CSRF token (not a staff one); sign-out ends the session", async () => {
    const staffMe = await app.inject({ method: "GET", url: "/api/v1/me", headers: { cookie: staffCookie } });
    const out = (headers: Record<string, string>) => app.inject({ method: "POST", url: "/api/portal/auth/sign-out", headers: { cookie: s.cookie, ...headers } });
    expect((await out({})).statusCode).toBe(403);
    expect((await out({ "x-csrf-token": staffMe.json().csrfToken })).statusCode).toBe(403);
    expect((await out({ "x-csrf-token": s.csrf })).statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: "/api/portal/me", headers: { cookie: s.cookie } })).statusCode).toBe(401);
  });

  it("audits ids only (no email, name or phone)", async () => {
    const rows = (await db.admin.query(`SELECT action, changes::text AS c FROM eureka.audit_event WHERE entity_type = 'applicant'`)).rows;
    expect(rows.map((r) => r.action)).toEqual(expect.arrayContaining(["applicant.sign_up", "applicant.signed_in"]));
    for (const r of rows) expect(r.c ?? "").not.toMatch(/@|Rakesh|Asha|\+1469/);
  });
});

describe("RLS, direct SQL", () => {
  let a: string, b: string;
  beforeAll(async () => {
    a = (await signUpAndIn("rls-a@example.com")).id;
    b = (await signUpAndIn("rls-b@example.com")).id;
  });
  const asApplicant = async <T>(id: string | null, sql: string) => {
    const c = await db.app.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL ROLE eureka_portal");
      if (id) await c.query("SELECT set_config('eureka.applicant_id', $1, true)", [id]);
      return (await c.query(sql)) as unknown as T;
    } finally { await c.query("ROLLBACK").catch(() => undefined); c.release(); }
  };

  it("eureka_portal is NOLOGIN, bypasses nothing, belongs to no role, and eureka_app does not inherit it", async () => {
    const r = (await db.admin.query(`SELECT rolcanlogin, rolsuper, rolbypassrls,
      (SELECT count(*)::int FROM pg_auth_members m WHERE m.member = r.oid) AS memberships,
      (SELECT bool_or(m.inherit_option) FROM pg_auth_members m JOIN pg_roles a ON a.oid = m.member WHERE m.roleid = r.oid AND a.rolname = 'eureka_app') AS app_inherits
      FROM pg_roles r WHERE rolname = 'eureka_portal'`)).rows[0];
    expect(r).toEqual({ rolcanlogin: false, rolsuper: false, rolbypassrls: false, memberships: 0, app_inherits: false });
  });

  it("the portal role sees only the signed-in applicant", async () => {
    const r = await asApplicant<{ rows: { id: string }[] }>(a, `SELECT id FROM eureka.applicant`);
    expect(r.rows.map((x) => x.id)).toEqual([a]);
    expect((await asApplicant<{ rowCount: number }>(null, `SELECT id FROM eureka.applicant`)).rowCount).toBe(0);
    expect((await asApplicant<{ rowCount: number }>(b, `SELECT id FROM eureka.applicant WHERE id = '${a}'`)).rowCount).toBe(0);
  });

  it("the portal role has no access to staff data or portal secrets", async () => {
    for (const sql of [`SELECT 1 FROM eureka.candidate`, `SELECT 1 FROM eureka.app_user`, `SELECT 1 FROM eureka.applicant_login_link`,
      `SELECT 1 FROM eureka.applicant_session`, `SELECT status FROM eureka.applicant`, `SELECT authz.portal_link_hash(gen_random_uuid())`]) {
      await expect(asApplicant(a, sql), sql).rejects.toMatchObject({ code: "42501" });
    }
    await expect(asApplicant(a, `UPDATE eureka.applicant SET first_name = 'x'`)).rejects.toMatchObject({ code: "42501" });
  });

  it("staff see applicants only with applicant:read; nobody writes them directly", async () => {
    const n = (u: string) => asUser(db.app, u, async (c) => (await c.query(`SELECT id FROM eureka.applicant WHERE id = ANY($1)`, [[a, b]])).rowCount);
    expect(await n(U.hr)).toBe(2);
    expect(await n(U.r1a)).toBe(0);
    expect(await n(U.ceo)).toBe(0);
    await expect(asUser(db.app, U.hr, (c) => c.query(`INSERT INTO eureka.applicant (first_name, last_name, email) VALUES ('x','y','z@example.com')`)))
      .rejects.toMatchObject({ code: "42501" });
    await expect(asUser(db.app, U.hr, (c) => c.query(`SELECT * FROM eureka.applicant_login_link`))).rejects.toMatchObject({ code: "42501" });
  });
});

import { createHash } from "node:crypto";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.module.js";
import { loadConfig } from "../src/platform/config.js";
import { portalCookieName } from "../src/platform/portal-session.service.js";
import { GENERIC_SENT, PortalAuthService } from "../src/modules/portal/portal-auth.service.js";
import { portalPruneJob } from "../src/worker/jobs/portal-prune.js";
import { silentLogger } from "../src/worker/log.js";
import { asUser, createTestDb, type TestDb } from "./db-harness.js";
import { U, seedFixtures } from "./fixtures.js";
import { ageLinks, drainPortal, mailboxOf, portalSignIn } from "./portal-seed.js";

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
const tokenOf = (text: string) => /#token=([^\s]+)/.exec(text)![1]!;
const signUp = async (email: string, first = "Asha", last = "Iyer", phone = "+91 98765 43210") => {
  const r = await post("/api/portal/auth/sign-up", { firstName: first, lastName: last, email, phone });
  await drainPortal(app);
  return r;
};
const applicant = async (email: string) =>
  (await db.admin.query(`SELECT first_name, last_name, phone_e164, email_verified_at FROM eureka.applicant WHERE email = lower($1)`, [email])).rows[0];

describe("sign-up and sign-in", () => {
  it("answers the same for new, existing and unknown emails; mails only real accounts, with a fixed greeting", async () => {
    const a = await signUp("Asha@Example.com ", "Click", "Evil-Link-Here");
    expect(a.statusCode).toBe(202);
    expect(a.json()).toEqual({ message: GENERIC_SENT });
    const again = await signUp("asha@example.com", "Mallory", "X", "+1 469 555 0199");
    expect(again.statusCode).toBe(202);
    expect(again.json()).toEqual(a.json());
    const unknown = await post("/api/portal/auth/request-link", { email: "nobody@example.com" });
    const known = await post("/api/portal/auth/request-link", { email: "asha@example.com" });
    expect(unknown.statusCode).toBe(202);
    expect(unknown.json()).toEqual(known.json());
    expect(await mailboxOf(app, "nobody@example.com")).toEqual([]);
    // One link only: the sign-up issued it, the rest were inside the 60-second cooldown (and counted nowhere).
    const mails = await mailboxOf(app, "asha@example.com");
    expect(mails).toHaveLength(1);
    expect(mails[0]!.subject).toBe("Confirm your email for Eureka Careers");
    expect(mails[0]!.text).toMatch(/^Hello,\n/);
    expect(mails[0]!.text).not.toMatch(/Click|Evil|Mallory/);
    expect(mails[0]!.text).toMatch(/\/portal\/verify#token=[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}/);
    // A second sign-up never overwrote the unverified row.
    expect(await applicant("asha@example.com")).toMatchObject({ first_name: "Click", phone_e164: "+919876543210", email_verified_at: null });
  });

  it("stores only hashes of link secrets", async () => {
    const secret = tokenOf((await mailboxOf(app, "asha@example.com"))[0]!.text).split(".")[1]!;
    const rows = (await db.admin.query(`SELECT secret_hash FROM eureka.applicant_login_link`)).rows;
    expect(JSON.stringify(rows)).not.toContain(secret);
    expect(rows.some((r) => (r.secret_hash as Buffer).equals(createHash("sha256").update(secret).digest()))).toBe(true);
  });

  it("the mailbox owner's own sign-up data replaces an attacker's when the owner redeems their link", async () => {
    await signUp("owner@example.com", "Attacker", "Name", "+1 212 555 0100");
    await ageLinks(db, "owner@example.com");
    await signUp("owner@example.com", "Olivia", "Owner", "+1 212 555 0199");
    const mails = await mailboxOf(app, "owner@example.com");
    expect(mails).toHaveLength(2);
    expect(await applicant("owner@example.com")).toMatchObject({ first_name: "Attacker" });
    expect((await post("/api/portal/auth/verify", { token: tokenOf(mails[0]!.text) })).statusCode).toBe(204); // the owner's (newest) link
    expect(await applicant("owner@example.com")).toMatchObject({ first_name: "Olivia", last_name: "Owner", phone_e164: "+12125550199" });
    expect((await db.admin.query(`SELECT email_verified_at FROM eureka.applicant WHERE email = 'owner@example.com'`)).rows[0].email_verified_at).not.toBeNull();
    // Verified now: a later sign-up neither changes the row nor reveals anything.
    await ageLinks(db, "owner@example.com");
    await signUp("owner@example.com", "Eve", "X", "+1 212 555 0111");
    await ageLinks(db, "owner@example.com");
    await post("/api/portal/auth/verify", { token: tokenOf((await mailboxOf(app, "owner@example.com"))[0]!.text) });
    expect(await applicant("owner@example.com")).toMatchObject({ first_name: "Olivia", phone_e164: "+12125550199" });
  });

  it("a link works once, burns the other open links and sets a strict, path-scoped cookie", async () => {
    await ageLinks(db, "asha@example.com");
    await post("/api/portal/auth/request-link", { email: "asha@example.com" });
    const mails = await mailboxOf(app, "asha@example.com");
    expect(mails).toHaveLength(2);
    const v = await post("/api/portal/auth/verify", { token: tokenOf(mails[0]!.text) });
    expect(v.statusCode).toBe(204);
    const set = String(v.headers["set-cookie"]);
    expect(set).toMatch(/^eureka_portal_sid=[A-Za-z0-9_-]{43};/);
    expect(set).toMatch(/Path=\/api\/portal/);
    expect(set).toMatch(/HttpOnly/);
    expect(set).toMatch(/SameSite=Strict/);
    expect((await post("/api/portal/auth/verify", { token: tokenOf(mails[0]!.text) })).json().detail).toBe("link_invalid");
    expect((await post("/api/portal/auth/verify", { token: tokenOf(mails[1]!.text) })).statusCode).toBe(400);
    expect((await applicant("asha@example.com")).email_verified_at).not.toBeNull();
  });

  it("refuses tampered, malformed and expired links with the same answer", async () => {
    await signUp("tamper@example.com", "Tam", "Per", "+1 469 555 0102");
    const token = tokenOf((await mailboxOf(app, "tamper@example.com"))[0]!.text);
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
    expect((await signUp("x@example.com", "A", "B", "12345")).statusCode).toBe(422);
    expect((await post("/api/portal/auth/sign-up", { firstName: "A", lastName: "B", email: "x@example.com", phone: "+1 469 555 0103", dob: "1990-01-01" })).statusCode).toBe(422);
    expect((await post("/api/portal/auth/request-link", { email: "not-an-email" })).statusCode).toBe(422);
  });
});

describe("no account oracle (timing, work after the reply)", () => {
  it("the answer does not wait for the database or the mail", async () => {
    await signUp("oracle@example.com", "Ora", "Cle", "+1 212 555 0120");
    await drainPortal(app);
    await ageLinks(db, "oracle@example.com");
    const svc = app.get(PortalAuthService);
    const before = (await app.inject({ method: "GET", url: "/api/portal/dev/mailbox?to=oracle%40example.com" })).json().items.length;
    const known = await svc.requestLink({ email: "oracle@example.com" }, "10.5.5.5");
    const unknown = await svc.requestLink({ email: "ghost@example.com" }, "10.5.5.6");
    expect(known).toEqual(unknown);
    // Nothing happened yet for the known address: the work is queued, not done.
    expect((await app.inject({ method: "GET", url: "/api/portal/dev/mailbox?to=oracle%40example.com" })).json().items.length).toBe(before);
    await svc.drain();
    expect((await app.inject({ method: "GET", url: "/api/portal/dev/mailbox?to=oracle%40example.com" })).json().items.length).toBe(before + 1);
  });
});

describe("limits", () => {
  it("asking for somebody's link does not lock them out: suppressed requests count nowhere", async () => {
    const v = await portalSignIn(app, "victim@example.com");
    for (let i = 0; i < 12; i++) await post("/api/portal/auth/request-link", { email: "victim@example.com" });
    await drainPortal(app);
    // 12 requests inside the cooldown issued nothing; after the cooldown the victim still gets a link at once.
    expect((await mailboxOf(app, "victim@example.com")).length).toBe(1);
    await ageLinks(db, "victim@example.com");
    await post("/api/portal/auth/request-link", { email: "victim@example.com" });
    expect((await mailboxOf(app, "victim@example.com")).length).toBe(2);
    expect(v.id).toBeTruthy();
  });

  it("per applicant: 10 links an hour, one per 60 seconds", async () => {
    await signUp("rate@example.com", "Rate", "Limit", "+1 469 555 0104");
    for (let i = 0; i < 14; i++) {
      await drainPortal(app);
      await ageLinks(db, "rate@example.com");
      const r = await post("/api/portal/auth/request-link", { email: "rate@example.com" });
      expect(r.statusCode).toBe(202);
      expect(r.json().message).toBe(GENERIC_SENT);
    }
    expect((await mailboxOf(app, "rate@example.com")).length).toBe(10);
  });

  it("database-wide hourly caps on new accounts and on links (shared by every task)", async () => {
    const run = async (sql: string, params: unknown[]) => (await asUser(db.app, U.hr, (c) => c.query(sql, params), true)).rows;
    const su = (email: string, globalSignups: number, globalLinks = 100) => run(
      `SELECT * FROM authz.portal_sign_up('A','B',$1,'+12125550101', gen_random_uuid(), sha256(convert_to($1::text, 'UTF8')), 15, 10, 60, $2, $3)`, [email, globalLinks, globalSignups]);
    const n = async () => (await db.admin.query(`SELECT count(*)::int AS n FROM eureka.applicant WHERE email LIKE 'cap-%'`)).rows[0].n as number;
    await db.admin.query(`DELETE FROM eureka.portal_throttle`).catch(() => undefined); // guard refuses: stays
    const t0 = (await db.admin.query(`SELECT coalesce(sum(n),0)::int AS n FROM eureka.portal_throttle WHERE kind = 'signup' AND bucket = date_trunc('hour', now())`)).rows[0].n as number;
    const cap = t0 + 2;
    expect((await su("cap-1@example.com", cap)).length).toBe(1);
    expect((await su("cap-2@example.com", cap)).length).toBe(1);
    expect((await su("cap-3@example.com", cap)).length).toBe(0); // nothing created, nothing to tell
    expect(await n()).toBe(2);
    // An existing address is unaffected by the new-account cap but still bound by the link cap.
    const l0 = (await db.admin.query(`SELECT coalesce(sum(n),0)::int AS n FROM eureka.portal_throttle WHERE kind = 'link' AND bucket = date_trunc('hour', now())`)).rows[0].n as number;
    await ageLinks(db, "cap-1@example.com");
    expect((await su("cap-1@example.com", cap, l0)).map((r) => r.issued)).toEqual([false]);
    expect((await su("cap-1@example.com", cap, l0 + 5)).map((r) => r.issued)).toEqual([true]);
  });

  it("per client address: 429 after 20 requests in 15 minutes; IPv6 is keyed by /64", async () => {
    const codes: number[] = [];
    for (let i = 0; i < 21; i++) codes.push((await post("/api/portal/auth/request-link", { email: `ip${i}@example.com` }, H, "10.9.9.9")).statusCode);
    expect(codes.slice(0, 20).every((c) => c === 202)).toBe(true);
    expect(codes[20]).toBe(429);
    const v6: number[] = [];
    for (let i = 0; i < 21; i++) v6.push((await post("/api/portal/auth/request-link", { email: `v6${i}@example.com` }, H, `2001:db8:1:2:${i.toString(16)}::${i + 1}`)).statusCode);
    expect(v6[19]).toBe(202);
    expect(v6[20]).toBe(429);
    expect((await post("/api/portal/auth/request-link", { email: "other@example.com" }, H, "2001:db8:1:3::1")).statusCode).toBe(202);
  });
});

describe("unverified applicants are pruned", () => {
  it("deletes old unverified applicants with no open link or application; keeps everyone else", async () => {
    await signUp("stale@example.com", "Sta", "Le", "+1 212 555 0130");
    await signUp("fresh@example.com", "Fre", "Sh", "+1 212 555 0131");
    const keep = await portalSignIn(app, "verified-old@example.com");
    await drainPortal(app);
    const c = await db.admin.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL session_replication_role = replica");
      await c.query(`UPDATE eureka.applicant SET created_at = now() - interval '60 days' WHERE email IN ('stale@example.com', 'verified-old@example.com')`);
      await c.query(`UPDATE eureka.applicant_login_link SET used_at = now() WHERE applicant_id IN (SELECT id FROM eureka.applicant WHERE email = 'stale@example.com')`);
      await c.query("COMMIT");
    } finally { c.release(); }
    const out = await portalPruneJob(30).run("2026-10-05", { pool: db.worker, log: silentLogger, signal: new AbortController().signal, heartbeat() {} } as never);
    expect((out as { deleted: number }).deleted).toBeGreaterThanOrEqual(1);
    const left = (await db.admin.query(`SELECT email FROM eureka.applicant WHERE email IN ('stale@example.com','fresh@example.com','verified-old@example.com') ORDER BY 1`)).rows.map((r) => r.email);
    expect(left).toEqual(["fresh@example.com", "verified-old@example.com"]);
    expect(keep.id).toBeTruthy();
    await expect(db.worker.query(`SELECT authz.portal_prune_unverified(7)`)).rejects.toThrow(/between 30 and 365/);
    await expect(db.worker.query(`DELETE FROM eureka.applicant`)).rejects.toMatchObject({ code: "42501" });
  });
});

describe("session separation", () => {
  let s: { cookie: string; csrf: string; id: string };
  let staffCookie: string;
  beforeAll(async () => {
    s = await portalSignIn(app, "sep@example.com");
    const r = await app.inject({ method: "POST", url: "/api/auth/dev-login", payload: { email: "hr@eureka.example" } });
    staffCookie = String(r.headers["set-cookie"]).split(";")[0]!;
  });

  it("portal routes take only applicant sessions", async () => {
    const me = await app.inject({ method: "GET", url: "/api/portal/me", headers: { cookie: s.cookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ firstName: "Rakesh", email: "sep@example.com", phone: "+12125550123", emailVerified: true });
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

  it("sign out everywhere ends every session of the applicant, and disabling an applicant does too", async () => {
    const one = await portalSignIn(app, "everywhere@example.com");
    await ageLinks(db, "everywhere@example.com");
    await post("/api/portal/auth/request-link", { email: "everywhere@example.com" });
    const link = tokenOf((await mailboxOf(app, "everywhere@example.com"))[0]!.text);
    const second = await post("/api/portal/auth/verify", { token: link });
    const two = String(second.headers["set-cookie"]).split(";")[0]!;
    for (const cookie of [one.cookie, two]) expect((await app.inject({ method: "GET", url: "/api/portal/me", headers: { cookie } })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/api/portal/auth/sign-out-all", headers: { cookie: one.cookie, "x-csrf-token": one.csrf } })).statusCode).toBe(204);
    for (const cookie of [one.cookie, two]) expect((await app.inject({ method: "GET", url: "/api/portal/me", headers: { cookie } })).statusCode).toBe(401);

    const d = await portalSignIn(app, "disabled@example.com");
    const c = await db.admin.connect();
    try {
      await c.query("SET ROLE authz_definer");
      await c.query(`UPDATE eureka.applicant SET status = 'disabled' WHERE id = $1`, [d.id]);
    } finally { await c.query("RESET ROLE"); c.release(); }
    expect((await db.admin.query(`SELECT count(*)::int AS n FROM eureka.applicant_session WHERE applicant_id = $1 AND revoked_at IS NULL`, [d.id])).rows[0].n).toBe(0);
    expect((await app.inject({ method: "GET", url: "/api/portal/me", headers: { cookie: d.cookie } })).statusCode).toBe(401);
  });

  it("production uses the __Secure- cookie name (path-scoped cookies cannot be __Host-)", () => {
    expect(portalCookieName(true)).toBe("__Secure-eureka_portal_sid");
    expect(portalCookieName(false)).toBe("eureka_portal_sid");
  });

  it("audits ids only (no email, name or phone)", async () => {
    const rows = (await db.admin.query(`SELECT action, changes::text AS c FROM eureka.audit_event WHERE entity_type = 'applicant'`)).rows;
    expect(rows.map((r) => r.action)).toEqual(expect.arrayContaining(["applicant.sign_up", "applicant.signed_in"]));
    for (const r of rows) expect(r.c ?? "").not.toMatch(/@|Rakesh|Asha|Olivia|\+1212/);
  });
});

describe("RLS, direct SQL", () => {
  let a: string, b: string;
  beforeAll(async () => {
    a = (await portalSignIn(app, "rls-a@example.com")).id;
    b = (await portalSignIn(app, "rls-b@example.com")).id;
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

  it("the portal role has no access to staff data, portal secrets or counters", async () => {
    for (const sql of [`SELECT 1 FROM eureka.candidate`, `SELECT 1 FROM eureka.app_user`, `SELECT 1 FROM eureka.applicant_login_link`,
      `SELECT 1 FROM eureka.applicant_session`, `SELECT 1 FROM eureka.portal_throttle`, `SELECT status FROM eureka.applicant`,
      `SELECT authz.portal_link_hash(gen_random_uuid())`, `SELECT authz.portal_take('link', 5)`]) {
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
    await expect(asUser(db.app, U.hr, (c) => c.query(`SELECT authz.portal_take('signup', 1000)`))).rejects.toMatchObject({ code: "42501" });
  });
});

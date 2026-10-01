/**
 * First-admin bootstrap (migration 0037, src/db/bootstrap.ts). Runs the CLI
 * code as an RDS-like migration user (a plain CREATEROLE login that is a
 * member of eureka_owner and authz_definer, not a superuser), so forced RLS
 * on audit_event and the candidate tables applies exactly as on Amazon RDS.
 */
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.module.js";
import { BootstrapError, bootstrap, parseBootstrapArgs } from "../src/db/bootstrap.js";
import { DEMO_EMAIL_DOMAIN, loadDemoData } from "../src/db/demo-data.js";
import { AuthController } from "../src/modules/identity/auth.controller.js";
import { loadConfig } from "../src/platform/config.js";
import { OidcService } from "../src/platform/oidc.service.js";
import { SESSION_COOKIE, SessionService } from "../src/platform/session.service.js";
import { asUser, createTestDb, type TestDb } from "./db-harness.js";

const DOMAIN = "eureka.example";
const ENV = { GOOGLE_HOSTED_DOMAIN: DOMAIN };
const SECRET = "test-secret-test-secret-test-secret-123";
const ADMIN_BASE = process.env.TEST_PG_ADMIN_URL ?? "postgres://postgres:postgres@127.0.0.1:5432";
const base = new URL(ADMIN_BASE);

let db: TestDb;
let app: NestFastifyApplication;
let rdsRole: string;
let rdsUrl: string;
let appUrl: string;

beforeAll(async () => {
  db = await createTestDb();
  rdsRole = `rds_boot_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  await db.admin.query(`CREATE ROLE ${rdsRole} LOGIN PASSWORD 'x' CREATEROLE`);
  await db.admin.query(`GRANT eureka_owner, authz_definer TO ${rdsRole} WITH SET TRUE, INHERIT TRUE`);
  await db.admin.query(`GRANT CONNECT ON DATABASE ${db.name} TO ${rdsRole}`);
  rdsUrl = `postgres://${rdsRole}:x@${base.host}/${db.name}`;
  appUrl = `postgres://eureka_app:eureka_app_test@${base.host}/${db.name}`;
  app = await createApp(loadConfig({
    NODE_ENV: "test", AUTH_MODE: "google", SESSION_SECRET: SECRET, DATABASE_URL: appUrl,
    GOOGLE_CLIENT_ID: "client-123", GOOGLE_CLIENT_SECRET: "s", GOOGLE_HOSTED_DOMAIN: DOMAIN,
  }));
}, 90_000);

afterAll(async () => {
  await app?.close();
  await db?.drop();
  const root = new pg.Client({ connectionString: `${ADMIN_BASE}/postgres` });
  await root.connect();
  await root.query(`DROP ROLE IF EXISTS ${rdsRole}`);
  await root.end();
});

const args = (...argv: string[]) => parseBootstrapArgs(argv, ENV);
const counts = async () => (await db.admin.query<{ users: number; roles: number; audit: number }>(
  `SELECT (SELECT count(*) FROM eureka.app_user)::int AS users, (SELECT count(*) FROM eureka.user_role)::int AS roles,
          (SELECT count(*) FROM eureka.audit_event)::int AS audit`)).rows[0]!;
const refusal = async (p: Promise<unknown>) => {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(BootstrapError);
  expect((err as BootstrapError).exitCode).toBe(3);
  return (err as Error).message;
};

let admin1: string;
let admin2: string;

describe("bootstrap before any admin exists", () => {
  it("is not executable by the API, worker or import roles", async () => {
    await expect(db.app.query(`SELECT * FROM authz.bootstrap_admins(ARRAY['x@${DOMAIN}'], ARRAY['x'], '${DOMAIN}')`))
      .rejects.toThrow(/permission denied/);
    await expect(db.worker.query(`SELECT * FROM authz.bootstrap_admins(ARRAY['x@${DOMAIN}'], ARRAY['x'], '${DOMAIN}')`))
      .rejects.toThrow(/permission denied/);
    const { rows } = await db.admin.query<{ r: string }>(
      `SELECT r FROM unnest(ARRAY['eureka_app','eureka_worker','eureka_import']) r
       WHERE has_function_privilege(r, 'authz.bootstrap_admins(text[], text[], text)', 'EXECUTE')`);
    expect(rows).toEqual([]);
  });

  it("the database re-checks the hosted domain, counts and names", async () => {
    const call = (emails: string[], names: string[], domain: string) => db.admin.query(
      `SELECT * FROM authz.bootstrap_admins($1::text[], $2::text[], $3)`, [emails, names, domain]);
    await expect(call([`a@evil.example`], ["a"], DOMAIN)).rejects.toThrow(/email_domain/);
    await expect(call([`a@sub.${DOMAIN}`], ["a"], DOMAIN)).rejects.toThrow(/email_domain/);
    await expect(call([`a@${DOMAIN}`], ["a"], "")).rejects.toThrow(/bootstrap_domain_invalid/);
    await expect(call([`a@${DOMAIN}`], ["a"], "not a domain")).rejects.toThrow(/bootstrap_domain_invalid/);
    await expect(call([], [], DOMAIN)).rejects.toThrow(/bootstrap_admin_count/);
    await expect(call([`a@${DOMAIN}`, `b@${DOMAIN}`, `c@${DOMAIN}`], ["a", "b", "c"], DOMAIN)).rejects.toThrow(/bootstrap_admin_count/);
    await expect(call([`a@${DOMAIN}`, `A@${DOMAIN}`], ["a", "b"], DOMAIN)).rejects.toThrow(/bootstrap_duplicate_email/);
    await expect(call([`a@${DOMAIN}`], ["  "], DOMAIN)).rejects.toThrow(/bootstrap_name_invalid/);
    expect(await counts()).toMatchObject({ users: 0, roles: 0, audit: 0 });
  });

  it("refuses an account that already holds a business role (separation of duties), and changes nothing", async () => {
    const { rows } = await db.admin.query<{ id: string }>(
      `INSERT INTO eureka.app_user (email, display_name) VALUES ('busy@${DOMAIN}', 'Busy') RETURNING id`);
    await db.admin.query(`INSERT INTO eureka.user_role (user_id, role_key) VALUES ($1, 'recruiter')`, [rows[0]!.id]);
    const before = await counts();
    expect(await refusal(bootstrap(rdsUrl, args("--admin", `ok@${DOMAIN}`, "--admin", `busy@${DOMAIN}`), null)))
      .toMatch(/already holds a role/);
    expect(await counts()).toEqual(before);
    await db.admin.query(`DELETE FROM eureka.user_role WHERE user_id = $1`, [rows[0]!.id]);
    await db.admin.query(`DELETE FROM eureka.app_user WHERE id = $1`, [rows[0]!.id]);
  });
});

describe("bootstrap creates the first admins once", () => {
  it("creates two org_admins (org_admin only, not yet linked to Google) and audits them as system without email", async () => {
    const r = await bootstrap(rdsUrl, args("--admin", `Ravi Admin <Ravi@${DOMAIN.toUpperCase()}>`, "--admin", `ops@${DOMAIN}`), null);
    expect(r.outcome).toBe("created");
    expect(r.admins.map((a) => a.outcome)).toEqual(["created", "created"]);
    const users = (await db.admin.query<{ id: string; email: string; display_name: string; google_sub: string | null; status: string; roles: string[] }>(
      `SELECT u.id, u.email::text, u.display_name, u.google_sub, u.status,
              array_agg(ur.role_key) FILTER (WHERE ur.valid @> now()) AS roles
       FROM eureka.app_user u LEFT JOIN eureka.user_role ur ON ur.user_id = u.id GROUP BY u.id ORDER BY u.email`)).rows;
    expect(users.map(({ id: _id, ...u }) => u)).toEqual([
      { email: `ops@${DOMAIN}`, display_name: "ops", google_sub: null, status: "active", roles: ["org_admin"] },
      { email: `ravi@${DOMAIN}`, display_name: "Ravi Admin", google_sub: null, status: "active", roles: ["org_admin"] },
    ]);
    admin1 = users[1]!.id;
    admin2 = users[0]!.id;
    const audit = (await db.admin.query<{ actor_id: string | null; action: string; entity_type: string; entity_id: string; changes: object }>(
      `SELECT actor_id, action, entity_type, entity_id, changes FROM eureka.audit_event ORDER BY seq`)).rows;
    expect(audit).toHaveLength(2);
    for (const a of audit) {
      expect(a).toMatchObject({ actor_id: null, action: "admin.bootstrap", entity_type: "app_user" });
      expect(a.changes).toEqual({ actor: "system:bootstrap", role: "org_admin", userCreated: true, admins: 2 });
      expect(JSON.stringify(a)).not.toContain("@");
    }
    expect(audit.map((a) => a.entity_id).sort()).toEqual([admin1, admin2].sort());
  });

  it("is idempotent: the same admins again (any order or case) change nothing", async () => {
    const before = await counts();
    const r = await bootstrap(rdsUrl, args("--admin", `OPS@${DOMAIN}`, "--admin", `ravi@${DOMAIN}`), null);
    expect(r.outcome).toBe("unchanged");
    expect(r.admins.map((a) => a.userId).sort()).toEqual([admin1, admin2].sort());
    expect(await counts()).toEqual(before);
  });

  it("refuses any other admin set while an active org_admin exists (no backdoor later)", async () => {
    const before = await counts();
    for (const argv of [
      ["--admin", `new@${DOMAIN}`, "--single-admin"],
      ["--admin", `ravi@${DOMAIN}`, "--single-admin"],
      ["--admin", `ravi@${DOMAIN}`, "--admin", `new@${DOMAIN}`],
    ]) {
      expect(await refusal(bootstrap(rdsUrl, args(...argv), null))).toMatch(/org_admin already exists/);
    }
    // Also when the admin was not created by bootstrap, e.g. one of two left.
    await db.admin.query(`UPDATE eureka.user_role SET valid = tstzrange(lower(valid), now()) WHERE user_id = $1`, [admin2]);
    expect(await refusal(bootstrap(rdsUrl, args("--admin", `ravi@${DOMAIN}`, "--admin", `ops@${DOMAIN}`), null)))
      .toMatch(/org_admin already exists/);
    await db.admin.query(`INSERT INTO eureka.user_role (user_id, role_key) VALUES ($1, 'org_admin')`, [admin2]);
    expect((await counts()).users).toBe(before.users);
  });
});

/** Google ID tokens signed with a local key the OIDC service is told to trust. */
let key: CryptoKey;
const token = (sub: string, email: string, hd = DOMAIN) =>
  new SignJWT({ email_verified: true, email, hd, nonce: "n1" }).setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer("https://accounts.google.com").setAudience("client-123").setSubject(sub)
    .setIssuedAt().setExpirationTime("5m").sign(key);

describe("the bootstrapped admins sign in with Google and administer", () => {
  beforeAll(async () => {
    const pair = await generateKeyPair("RS256");
    key = pair.privateKey as CryptoKey;
    const jwk = { ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "RS256" };
    app.get(OidcService).useKeySet(createLocalJWKSet({ keys: [jwk] }));
  });

  async function signIn(sub: string, email: string) {
    const identity = await app.get(OidcService).verify(await token(sub, email), "n1");
    const userId = await app.get(AuthController).linkUser(identity.sub, identity.email);
    const sid = await app.get(SessionService).create(userId, identity.authTime);
    const cookie = `${SESSION_COOKIE}=${sid}`;
    const me = await app.inject({ method: "GET", url: "/api/v1/me", headers: { cookie } });
    expect(me.statusCode).toBe(200);
    return { userId, cookie, csrf: me.json().csrfToken as string, me: me.json() };
  }

  it("first sign-in links the Google account by email (case-insensitive) to the created user, then by sub", async () => {
    const s = await signIn("google-sub-ravi", `Ravi@${DOMAIN}`);
    expect(s.userId).toBe(admin1);
    expect(s.me.roles).toEqual([{ key: "org_admin", label: expect.any(String), locationId: null }]);
    const sub = (await db.admin.query(`SELECT google_sub FROM eureka.app_user WHERE id = $1`, [admin1])).rows[0].google_sub;
    expect(sub).toBe("google-sub-ravi");
    expect((await signIn("google-sub-ravi", `ravi@${DOMAIN}`)).userId).toBe(admin1);
    // Another Google account with the same email cannot take the user over.
    await expect(app.get(AuthController).linkUser("other-sub", `ravi@${DOMAIN}`)).rejects.toThrow(/No active Eureka account/);
  });

  it("two admins can grant a restricted role: one requests, the other approves (AD-3)", async () => {
    const a1 = await signIn("google-sub-ravi", `ravi@${DOMAIN}`);
    const a2 = await signIn("google-sub-ops", `ops@${DOMAIN}`);
    const post = (s: typeof a1, url: string, payload?: unknown) => app.inject({
      method: "POST", url, payload: payload as never, headers: { cookie: s.cookie, "x-csrf-token": s.csrf } });
    const created = await post(a1, "/api/v1/admin/users", { email: `hr1@${DOMAIN}`, displayName: "HR One" });
    expect(created.statusCode).toBe(201);
    const outside = await post(a1, "/api/v1/admin/users", { email: "hr2@gmail.com", displayName: "HR Two" });
    expect(outside.statusCode).toBe(422);
    const req = await post(a1, "/api/v1/admin/role-requests", { userId: created.json().id, role: "hr" });
    expect(req.json()).toMatchObject({ status: "pending_approval" });
    expect((await post(a1, `/api/v1/admin/role-requests/${req.json().id}/approve`)).statusCode).toBe(403);
    const ok = await post(a2, `/api/v1/admin/role-requests/${req.json().id}/approve`);
    expect(ok.json()).toEqual({ status: "approved" });
    // org_admin holds no business data: no candidates for the admins (rule 7).
    expect(await asUser(db.app, admin1, async (c) => (await c.query("SELECT count(*)::int AS n FROM eureka.candidate")).rows[0].n)).toBe(0);
  });
});

describe("--demo-data", () => {
  it("loads a fictional org through RLS: users cannot sign in, data shows only through role scopes", async () => {
    const before = (await counts()).audit;
    const r = await bootstrap(rdsUrl, args("--admin", `ravi@${DOMAIN}`, "--admin", `ops@${DOMAIN}`, "--demo-data"), appUrl);
    expect(r.outcome).toBe("unchanged");
    expect(r.demo).toEqual({ org: "created", candidatesCreated: 32, submissionsCreated: 12 });

    const demo = (await db.admin.query<{ id: string; email: string; google_sub: string | null; roles: string[] }>(
      `SELECT u.id, u.email::text, u.google_sub, array_agg(ur.role_key) AS roles FROM eureka.app_user u
       JOIN eureka.user_role ur ON ur.user_id = u.id WHERE u.email::text LIKE '%@${DEMO_EMAIL_DOMAIN}' GROUP BY u.id`)).rows;
    expect(demo).toHaveLength(12);
    expect(demo.every((u) => u.google_sub === null && !u.roles.includes("org_admin"))).toBe(true);
    // Not in the hosted domain, so Google sign-in can never produce these emails.
    await expect(app.get(OidcService).verify(await token("x", `demo-r1a@${DEMO_EMAIL_DOMAIN}`, DEMO_EMAIL_DOMAIN), "n1"))
      .rejects.toThrow(/company domain/);

    const id = (key: string) => demo.find((u) => u.email === `demo-${key}@${DEMO_EMAIL_DOMAIN}`)!.id;
    const visible = (userId: string) => asUser(db.app, userId, async (c) =>
      (await c.query<{ n: number }>("SELECT count(*)::int AS n FROM eureka.candidate")).rows[0]!.n);
    expect(await visible(id("r1a"))).toBe(16); // team Rohit (two recruiters)
    expect(await visible(id("r2a"))).toBe(8); // team Anjali
    expect(await visible(id("l1"))).toBe(16); // team Rohit
    expect(await visible(id("ad"))).toBe(32); // whole hierarchy
    expect(await visible(id("locd"))).toBe(24); // Demo Dallas: teams Rohit and Vikram
    expect(await visible(admin1)).toBe(0); // org_admin: no data role
    // Candidate and submission writes were audited by their recruiter; the org by the system.
    const audit = (await db.admin.query<{ action: string; n: number; system: boolean }>(
      `SELECT action, count(*)::int AS n, bool_and(actor_id IS NULL) AS system FROM eureka.audit_event
       WHERE seq > (SELECT max(seq) FROM eureka.audit_event) - 100 GROUP BY action ORDER BY action`)).rows;
    expect(audit).toEqual(expect.arrayContaining([
      { action: "admin.bootstrap_demo", n: 1, system: true },
      { action: "candidate.created", n: 32, system: false },
      { action: "submission.created", n: 12, system: false },
    ]));
    expect((await counts()).audit).toBeGreaterThan(before);
  });

  it("re-running adds nothing", async () => {
    const before = await counts();
    const r = await bootstrap(rdsUrl, args("--admin", `ravi@${DOMAIN}`, "--admin", `ops@${DOMAIN}`, "--demo-data"), appUrl);
    expect(r.demo).toEqual({ org: "existing", candidatesCreated: 0, submissionsCreated: 0 });
    expect(await counts()).toEqual(before);
  });

  it("refuses a stack that holds real candidates", async () => {
    const hr = (await db.admin.query<{ id: string }>(`SELECT id FROM eureka.app_user WHERE email = 'hr1@${DOMAIN}'`)).rows[0]!.id;
    const loc = (await db.admin.query<{ id: string }>(`SELECT id FROM eureka.location LIMIT 1`)).rows[0]!.id;
    const tech = (await db.admin.query<{ id: string }>(`SELECT id FROM eureka.technology LIMIT 1`)).rows[0]!.id;
    const team = (await db.admin.query<{ id: string }>(
      `INSERT INTO eureka.team (name, lead_id) VALUES ('Real team', $1) RETURNING id`, [hr])).rows[0]!.id;
    const person = (await db.admin.query<{ id: string }>(
      `INSERT INTO eureka.person (first_name, last_name) VALUES ('Real', 'Person') RETURNING id`)).rows[0]!.id;
    await db.admin.query(`INSERT INTO eureka.candidate (person_id, technology_id, team_id, location_id) VALUES ($1,$2,$3,$4)`,
      [person, tech, team, loc]);
    await expect(loadDemoData(rdsUrl, appUrl)).rejects.toMatchObject({ refused: true, message: expect.stringMatching(/1 real candidates/) });
  });
});

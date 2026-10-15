/**
 * Upload page (docs/import.md "Upload page"; staging/local only): a fictional team
 * workbook goes through the API as the admin would use it, with placeholder staff
 * from staging-team.ts, single-admin sign-off (0087) and the background load.
 */
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.module.js";
import { setupTeam, STAFF_EMAIL_DOMAIN } from "../src/db/staging-team.js";
import { setImportLogin } from "../src/db/migrate.js";
import { loadConfig } from "../src/platform/config.js";
import { createTestDb, type TestDb } from "./db-harness.js";
import { seedFixtures, U } from "./fixtures.js";
import { makeXlsx } from "./xlsx-fixture.js";

const ADMIN_BASE = process.env.TEST_PG_ADMIN_URL ?? "postgres://postgres:postgres@127.0.0.1:5432";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const SUB_H = ["Date", "Candidate Name", "Technology", "Rate", "Vendor", "Client", "Manager", "Team Lead", "Recruiter Name"];
const IV_H = ["Date", "Candidate Name", "Recruiter Name", "Manager", "Team Lead", "Technology", "Support Name", "Interview Type",
  "Feedback From Client", "Feedback From Candidate", "Reason For Rejection"];
// Fictional people and companies only.
const WORKBOOK = makeXlsx([
  { name: "Rohit Submissions", importRange: "Submissions!A:I", rows: [SUB_H,
    ["2026-08-03", "Asha Verma", "Java", "65", "northwind staffing", "Woodgrove Bank", "Mira Shah", "Rohit Das", "Priya Nair"],
    ["2026-08-04", "Asha Verma", "Java", "70", "fabrikam", "Fourth Coffee", "Mira Shah", "Rohit Das", "Priya  Nair"],
    ["2026-08-20", "Ben Cole", "Kotlin", "60", "fabrikam", "Proseware", "Mira Shah", "Rohit Das", "Sam Lee"],
  ] },
  { name: "Rohit Interviews", importRange: "Interviews!A:K", rows: [IV_H,
    ["2026-08-25", "Ben Cole", "Sam Lee", "Mira Shah", "Rohit Das", "Kotlin", "Self", "L1", "Selected", "Good", ""],
  ] },
  { name: "Notes", rows: [["Week", "Comment", "Owner"], ["1", "kick-off", "x"]] },
]);

let db: TestDb;
let app: NestFastifyApplication;
let batchId: string;
const adminUrl = () => `${ADMIN_BASE}/${db.name}`;

beforeAll(async () => {
  db = await createTestDb();
  await seedFixtures(db.admin);
  await db.admin.query(`INSERT INTO authz.policy_setting (key, value) VALUES ('single_admin_mode', 'on')
    ON CONFLICT (key) DO UPDATE SET value = 'on'`);
  await db.admin.query(`ALTER ROLE eureka_import LOGIN PASSWORD 'eureka_import_test'`);
  const u = new URL(ADMIN_BASE);
  app = await createApp(loadConfig({
    NODE_ENV: "test", AUTH_MODE: "dev", SESSION_SECRET: "test-secret-test-secret-test-secret-123",
    GOOGLE_HOSTED_DOMAIN: "eureka.example", DATABASE_URL: `postgres://eureka_app:eureka_app_test@${u.host}/${db.name}`,
    EUREKA_ENVIRONMENT: "local", IMPORT_UPLOAD: "on",
    IMPORT_DATABASE_URL: `postgres://eureka_import:eureka_import_test@${u.host}/${db.name}`,
    IMPORT_HMAC_KEY: "test-upload-hmac-key-test-upload-hmac-key",
  }));
}, 90_000);

afterAll(async () => {
  await app?.close();
  await db?.admin.query(`ALTER ROLE eureka_import NOLOGIN PASSWORD NULL`).catch(() => undefined);
  await db?.drop();
});

const sessions = new Map<string, { cookie: string; csrf: string }>();
async function call(key: "admin" | "r1a", method: "GET" | "POST", url: string, payload?: unknown, headers: Record<string, string> = {}) {
  let s = sessions.get(key);
  if (!s) {
    const res = await app.inject({ method: "POST", url: "/api/auth/dev-login", payload: { email: `${key}@eureka.example` } });
    const cookie = String(res.headers["set-cookie"]).split(";")[0]!;
    const me = await app.inject({ method: "GET", url: "/api/v1/me", headers: { cookie } });
    s = { cookie, csrf: me.json().csrfToken as string };
    sessions.set(key, s);
  }
  return app.inject({ method, url, payload: payload as never,
    headers: { cookie: s.cookie, ...(method !== "GET" ? { "x-csrf-token": s.csrf } : {}), ...headers } });
}
const report = async () => (await call("admin", "GET", `/api/v1/import-workbooks/${batchId}`)).json();
const states = (r: { sheets: Record<string, Record<string, number>> }, sheet: string) => {
  const t = r.sheets[sheet]!;
  return { in: t.in, clean: t.clean, review: t.review, held: t.held, committed: t.committed };
};

describe("configuration", () => {
  const base = { NODE_ENV: "test", AUTH_MODE: "dev", SESSION_SECRET: "x".repeat(40), DATABASE_URL: "postgres://a@b/c" };
  it("refuses the upload page outside staging and local, or without its secrets", () => {
    const issues = (env: Record<string, string>) => {
      try { loadConfig({ ...base, ...env }); return []; } catch (e) { return [(e as Error).message]; }
    };
    const ok = { IMPORT_UPLOAD: "on", IMPORT_DATABASE_URL: "postgres://eureka_import@h/d", IMPORT_HMAC_KEY: "k".repeat(32) };
    expect(issues({ ...ok, EUREKA_ENVIRONMENT: "staging" })).toEqual([]);
    expect(issues({ ...ok, EUREKA_ENVIRONMENT: "production" })).toContainEqual(expect.stringMatching(/only allowed when EUREKA_ENVIRONMENT/));
    expect(issues({ IMPORT_UPLOAD: "on", EUREKA_ENVIRONMENT: "staging" })).toContainEqual(expect.stringMatching(/needs IMPORT_DATABASE_URL/));
  });

  it("migrate gives eureka_import a login only in staging/local with the page on", async () => {
    const c = new pg.Client({ connectionString: adminUrl() });
    await c.connect();
    const login = async () => (await c.query<{ l: boolean }>(`SELECT rolcanlogin AS l FROM pg_roles WHERE rolname = 'eureka_import'`)).rows[0]!.l;
    try {
      expect(await setImportLogin(c, { EUREKA_ENVIRONMENT: "production", IMPORT_UPLOAD: "on", IMPORT_DB_PASSWORD: "p".repeat(40) })).toBe("untouched");
      expect(await login()).toBe(true); // as the test set it
      expect(await setImportLogin(c, { EUREKA_ENVIRONMENT: "staging", IMPORT_UPLOAD: "off" })).toBe("nologin");
      expect(await login()).toBe(false);
      expect(await setImportLogin(c, { EUREKA_ENVIRONMENT: "staging", IMPORT_UPLOAD: "on", IMPORT_DB_PASSWORD: "eureka_import_test".padEnd(32, "x") })).toBe("login");
      expect(await login()).toBe(true);
    } finally {
      await c.query(`ALTER ROLE eureka_import LOGIN PASSWORD 'eureka_import_test'`);
      await c.end();
    }
  });
});

describe("upload page", () => {
  it("is for org admins only", async () => {
    expect((await call("r1a", "GET", "/api/v1/import-workbooks")).statusCode).toBe(403);
    expect((await call("admin", "GET", "/api/v1/import-workbooks")).json()).toEqual({ enabled: true, items: [] });
  });

  it("refuses anything but the workbook itself", async () => {
    const r = await call("admin", "POST", "/api/v1/import-workbooks", { not: "a file" });
    expect(r.statusCode).toBe(400);
    const bad = await call("admin", "POST", "/api/v1/import-workbooks", Buffer.from("PK nope"), { "content-type": XLSX });
    expect(bad.statusCode).toBe(422);
  });

  it("stages an upload; rows wait for staff the empty org doesn't have", async () => {
    const r = await call("admin", "POST", "/api/v1/import-workbooks?asOf=2026-10-10", WORKBOOK, { "content-type": XLSX });
    expect(r.statusCode, r.body).toBe(201);
    const out = r.json();
    batchId = out.batchId;
    expect(out.workbook).toMatchObject({ ignored: ["Notes"], candidates: 2,
      tabs: [{ tab: "Rohit Submissions", kind: "submissions", team: "Rohit", rows: 3 }, { tab: "Rohit Interviews", kind: "interviews", team: "Rohit", rows: 1 }] });
    const rep = await report();
    expect(rep.sheets.sales.reasons.review).toMatchObject({ "unknown_owner:owner": 2 });
    expect(rep.sheets.sales.reasons.review["unknown_technology:technology"]).toBe(1); // Kotlin
    expect((await call("admin", "GET", "/api/v1/import-workbooks")).json().items).toEqual([
      expect.objectContaining({ id: batchId, status: "staged", operator: "admin@eureka.example", asOf: "2026-10-10" })]);
  });

  it("staging-team creates the location, technologies and placeholder staff; re-analysis then resolves owners", async () => {
    const env = { EUREKA_ENVIRONMENT: "local" };
    await expect(setupTeam(adminUrl(), { batch: batchId, location: "Head office", viewer: null }, { EUREKA_ENVIRONMENT: "production" }))
      .rejects.toThrow(/refused/);
    const first = await setupTeam(adminUrl(), { batch: batchId, location: "Head office", viewer: null }, env);
    // Mira Shah (manager), Rohit Das (lead), Priya Nair, Sam Lee (recruiters); Kotlin.
    expect(first).toEqual({ location: "created", technologies: 1, users: 4, teams: 1, viewer: "none" });
    expect(await setupTeam(adminUrl(), { batch: batchId, location: "Head office", viewer: null }, env))
      .toEqual({ location: "existing", technologies: 0, users: 0, teams: 0, viewer: "none" });
    await expect(setupTeam(adminUrl(), { batch: batchId, location: "Head office", viewer: "admin@eureka.example" }, env))
      .rejects.toThrow(/org admin/);
    const staff = (await db.admin.query<{ email: string; display_name: string; role: string }>(
      `SELECT u.email::text, u.display_name, ur.role_key AS role FROM eureka.app_user u JOIN eureka.user_role ur ON ur.user_id = u.id
        WHERE u.email::text LIKE $1 ORDER BY 2`, [`%@${STAFF_EMAIL_DOMAIN}`])).rows;
    expect(staff.map((s) => [s.display_name, s.role])).toEqual([
      ["Mira Shah", "manager"], ["Priya Nair", "recruiter"], ["Rohit Das", "lead"], ["Sam Lee", "recruiter"]]);

    const rep = (await call("admin", "POST", `/api/v1/import-workbooks/${batchId}/reanalyse`)).json();
    expect(states(rep, "sales")).toMatchObject({ in: 2, clean: 2 });
    expect(states(rep, "submissions")).toMatchObject({ in: 3, clean: 3 });
    expect(rep.sheets.interviews.reasons.review).toEqual({ inferred_client: 1 });
  });

  it("one admin approves their own batch in single-admin mode, never otherwise", async () => {
    const review = (await call("admin", "GET", `/api/v1/imports/${batchId}/review`)).json().items;
    for (const r of review.filter((x: { approvable: boolean }) => x.approvable)) {
      expect((await call("admin", "POST", `/api/v1/imports/${batchId}/decisions`, { sheet: r.sheet, rowNo: r.rowNo, action: "approve" })).statusCode).toBe(200);
    }
    await call("admin", "POST", `/api/v1/import-workbooks/${batchId}/reanalyse`);
    const p = (await call("admin", "GET", `/api/v1/imports/${batchId}/preview`)).json();
    expect(p.problems).toEqual([]);
    expect(p.newReferences.clients).toEqual(["Fourth Coffee", "Proseware", "Woodgrove Bank"]);

    await db.admin.query(`UPDATE authz.policy_setting SET value = 'off' WHERE key = 'single_admin_mode'`);
    const refused = await call("admin", "POST", `/api/v1/imports/${batchId}/approve`, { digest: p.digest });
    expect(refused.json().detail).toBe("second_person_required");
    await db.admin.query(`UPDATE authz.policy_setting SET value = 'on' WHERE key = 'single_admin_mode'`);
    const ok = await call("admin", "POST", `/api/v1/imports/${batchId}/approve`, { digest: p.digest });
    expect(ok.statusCode, ok.body).toBe(200);
  });

  it("loads in the background; the page polls until it is done", async () => {
    const r = await call("admin", "POST", `/api/v1/import-workbooks/${batchId}/load`);
    expect(r.statusCode, r.body).toBe(202);
    let rep = await report();
    for (let i = 0; i < 100 && rep.load?.running; i++) {
      await new Promise((res) => setTimeout(res, 100));
      rep = await report();
    }
    expect(rep.load.error).toBeUndefined();
    expect(rep.load.result.loaded).toEqual({ candidates: 2, submissions: 3, interviews: 1, placements: 0, updated: 0 });
    expect(rep.status).toBe("committed");
    const subs = (await db.admin.query<{ recruiter: string; team: string; location: string }>(
      `SELECT u.display_name AS recruiter, t.name AS team, l.name AS location FROM eureka.submission s
         JOIN eureka.app_user u ON u.id = s.recruiter_id JOIN eureka.team t ON t.id = s.team_id
         JOIN eureka.candidate c ON c.id = s.candidate_id JOIN eureka.location l ON l.id = c.location_id ORDER BY s.submitted_at`)).rows;
    expect(subs).toEqual([
      { recruiter: "Priya Nair", team: "Rohit", location: "Head office" },
      { recruiter: "Priya Nair", team: "Rohit", location: "Head office" },
      { recruiter: "Sam Lee", team: "Rohit", location: "Head office" },
    ]);
    expect((await call("admin", "POST", `/api/v1/import-workbooks/${batchId}/load`)).statusCode).toBe(409);
    // The fixture's own users are untouched.
    expect((await db.admin.query(`SELECT count(*)::int AS n FROM eureka.submission WHERE recruiter_id = $1`, [U.r1a])).rows[0].n).toBe(0);
  });
});

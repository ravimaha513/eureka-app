/**
 * Team workbooks (docs/import.md "Team workbooks"): a fictional workbook goes
 * through the adapter, staging, review, two-person sign-off and the database
 * loader (0086): submissions with their own dates and rates, recruiters named
 * rather than emailed, new clients and vendors, an inferred interview client.
 */
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.module.js";
import { makeHmac } from "../src/import/analyze.js";
import { TEAM_WORKBOOK_MAPPING_PATH } from "../src/import/cli.js";
import { commitBatch } from "../src/import/commit.js";
import { reconcile } from "../src/import/report.js";
import { recompute, stageTexts } from "../src/import/stage.js";
import { personRef, teamWorkbook, workbookTexts } from "../src/import/team-workbook.js";
import type { WorkbookSheet } from "../src/import/xlsx.js";
import { loadConfig } from "../src/platform/config.js";
import { createTestDb, type TestDb } from "./db-harness.js";
import { LOC, T, U, seedFixtures } from "./fixtures.js";

const ADMIN_BASE = process.env.TEST_PG_ADMIN_URL ?? "postgres://postgres:postgres@127.0.0.1:5432";
const hmac = makeHmac("test-import-hmac-key-test-import-hmac-key");
const AS_OF = "2026-10-10";

const SUB_H = ["Date", "Candidate Name", "Technology", "Rate", "Vendor", "Client", "Manager", "Team Lead", "Recruiter Name"];
const IV_H = ["Date", "Candidate Name", "Recruiter Name", "Manager", "Team Lead", "Technology", "Support Name", "Interview Type",
  "Feedback From Client", "Feedback From Candidate", "Reason For Rejection"];
const PL_H = ["Date", "Canddiate Name", "Technology", "Rate", "Vendor", "Client", "Manager", "Team Lead", "Recruiter Name",
  "BGV Status", "Placement Date", "Joining Date", "Phone Number", "Marketing Company", "Everify Company"];
const src = (tab: string) => ({ spreadsheetId: "1fictional", range: `${tab}!A:K`, tab });
// Fictional: recruiters Priya Nair (r1a), Sam Lee (r1b, only through the mapping's owners list), Kiran Rao (r2a).
const SHEETS: WorkbookSheet[] = [
  { name: "Rohit Submissions", headerRow: 1, headers: SUB_H, source: src("Submissions"), rows: [
    ["2026-08-03", "Asha Verma", "Java", "65", "northwind staffing", "Contoso / Northwind Financial", "Mira Shah", "Rohit Das", "Priya Nair"],
    ["08/04/2026", "Asha Verma", "Java", "$70/", "Fabrikam", "Woodgrove Bank", "Mira Shah", "Rohit Das", "Priya  Nair"],
    ["2026-08-20", "Ben Cole", "Python", "60hr", "fabrikam", "Proseware - 3/12", "Mira Shah", "Rohit Das", "Sam Lee"],
  ] },
  { name: "Rohit Interviews", headerRow: 1, headers: IV_H, source: src("Interviews"), rows: [
    ["2026-08-25", "Ben Cole", "Sam Lee", "Mira Shah", "Rohit Das", "Python", "Other Resource", "L1", "Selected", "Good", ""],
    ["2026-08-10", "Asha Verma", "Priya Nair", "Mira Shah", "Rohit Das", "Java", "Jason", "L2", "Hold", "", ""],
  ] },
  { name: "Anjali Submissions", headerRow: 1, headers: SUB_H, source: src("Submissions"), rows: [
    ["2026-08-05", "ASHA VERMA", "Java", "66", "tailspin", "Fourth Coffee", "Mira Shah", "Anjali Rao", "Kiran Rao"],
    ["2026-08-06", "Dev Patel", "Java", "62", "tailspin", "confidential", "Mira Shah", "Anjali Rao", "Kiran Rao"],
  ] },
  { name: "Anjali Placements", headerRow: 1, headers: PL_H, rows: [
    ["2026-09-01", "Asha Verma", "Java", "66", "tailspin", "Fourth Coffee", "Mira Shah", "Anjali Rao", "Kiran Rao",
      "Done", "2026-09-01", "2026-09-15", "214-555-0101", "Fictional Tech LLC", "Fictional Tech LLC"],
  ] },
];

let db: TestDb;
let imp: pg.Pool;
let app: NestFastifyApplication;
let batchId: string;
const mapping = () => {
  const m = JSON.parse(readFileSync(TEAM_WORKBOOK_MAPPING_PATH, "utf8"));
  m.owners["Sam Lee"] = "r1b@eureka.example";
  return JSON.stringify(m);
};

beforeAll(async () => {
  db = await createTestDb();
  await seedFixtures(db.admin);
  await db.admin.query(`INSERT INTO eureka.technology (name) VALUES ('Python')`);
  for (const [id, name] of [[U.r1a, "Priya Nair"], [U.r1b, "S. Lee"], [U.r2a, "Kiran Rao"]] as const) {
    await db.admin.query(`UPDATE eureka.app_user SET display_name = $2, primary_location_id = $3 WHERE id = $1`, [id, name, LOC.dallas]);
  }
  await db.admin.query(`ALTER ROLE eureka_import LOGIN PASSWORD 'eureka_import_test'`);
  const u = new URL(ADMIN_BASE);
  imp = new pg.Pool({ connectionString: `postgres://eureka_import:eureka_import_test@${u.host}/${db.name}`, max: 2 });
  app = await createApp(loadConfig({
    NODE_ENV: "test", AUTH_MODE: "dev", SESSION_SECRET: "test-secret-test-secret-test-secret-123",
    GOOGLE_HOSTED_DOMAIN: "eureka.example", DATABASE_URL: `postgres://eureka_app:eureka_app_test@${u.host}/${db.name}`,
  }));
}, 90_000);

afterAll(async () => {
  await app?.close();
  await imp?.end();
  await db?.admin.query(`ALTER ROLE eureka_import NOLOGIN PASSWORD NULL`).catch(() => undefined);
  await db?.drop();
});

const sessions = new Map<string, { cookie: string; csrf: string }>();
async function call(key: "admin" | "admin2", method: "GET" | "POST", url: string, payload?: unknown) {
  let s = sessions.get(key);
  if (!s) {
    const res = await app.inject({ method: "POST", url: "/api/auth/dev-login", payload: { email: `${key}@eureka.example` } });
    const cookie = String(res.headers["set-cookie"]).split(";")[0]!;
    const me = await app.inject({ method: "GET", url: "/api/v1/me", headers: { cookie } });
    s = { cookie, csrf: me.json().csrfToken as string };
    sessions.set(key, s);
  }
  return app.inject({ method, url, payload: payload as never, headers: { cookie: s.cookie, ...(method !== "GET" ? { "x-csrf-token": s.csrf } : {}) } });
}
const ticket = async () => (await call("admin", "POST", "/api/v1/imports/tickets")).json().ticket as string;
const stageWorkbook = async () => stageTexts(imp, workbookTexts(teamWorkbook(SHEETS, { asOf: AS_OF }), "team.xlsx", AS_OF), mapping(),
  { ticket: await ticket(), hmac });
const rowsOf = async (sheet: string) => (await imp.query<{ row_no: number; state: string; reasons: string[] }>(
  `SELECT row_no, state, reasons FROM eureka.import_row WHERE batch_id = $1 AND sheet = $2 ORDER BY row_no`, [batchId, sheet])).rows
  .map((r) => [r.row_no, r.state, r.reasons.join(",")]);

describe("team workbook import", () => {
  it("stages people, submissions, interviews and placements from the tabs", async () => {
    batchId = (await stageWorkbook()).batchId;
    // People: Asha (2 teams), Ben, Dev.
    expect(await rowsOf("sales")).toEqual([[2, "clean", ""], [3, "clean", ""], [4, "clean", ""]]);
    expect(await rowsOf("submissions")).toEqual([
      [2, "clean", ""], [3, "clean", ""], [4, "clean", ""], [5, "clean", ""],
      [6, "review", "missing:client"], // "confidential" is on the ignore list
    ]);
    // Ben's client is inferred (approvable); Asha's interview has none.
    expect(await rowsOf("interviews")).toEqual([[2, "review", "inferred_client"], [3, "review", "missing:client"]]);
    expect(await rowsOf("placements")).toEqual([[2, "review", "missing:placementType,missing:workMode"]]);
    const rep = await reconcile(imp, batchId);
    expect(rep.balanced).toBe(true);
    expect(rep.files.submissions).toMatchObject({ source: { adapter: "team-workbook", asOf: AS_OF } });
  });

  it("people are owned by the recruiter with most submissions, at the owner's location, open to all teams when shared", async () => {
    const r = (await imp.query<{ norm: Record<string, unknown> }>(
      `SELECT norm FROM eureka.import_row WHERE batch_id = $1 AND sheet = 'sales' AND row_no = 2`, [batchId])).rows[0]!.norm;
    expect(r).toMatchObject({ firstName: "Asha", lastName: "Verma", ownerId: U.r1a, locationId: LOC.dallas, visibility: "all_teams",
      phone: "+12145550101", personRef: personRef("Asha Verma").toLowerCase() });
  });

  it("an approved inference loads; the preview lists every new reference name", async () => {
    expect((await call("admin", "POST", `/api/v1/imports/${batchId}/decisions`, { sheet: "interviews", rowNo: 2, action: "approve" })).statusCode).toBe(200);
    await recompute(imp, batchId, hmac);
    expect((await rowsOf("interviews"))[0]).toEqual([2, "clean", ""]);
    const p = (await call("admin2", "GET", `/api/v1/imports/${batchId}/preview`)).json();
    expect(p.problems).toEqual([]);
    expect(p.newReferences).toEqual({
      clients: ["Fourth Coffee", "Proseware - 3/12", "Woodgrove Bank"], // Northwind Financial exists
      vendors: ["Fabrikam", "northwind staffing", "tailspin"], partners: [], // "fabrikam" is the same vendor
    });
    expect(p.perOwner).toContainEqual(expect.objectContaining({ owner: "r1a@eureka.example", candidates: 1, submissions: 2 }));
    const ok = await call("admin2", "POST", `/api/v1/imports/${batchId}/approve`, { digest: p.digest });
    expect(ok.statusCode, ok.body).toBe(200);
  });

  it("commits submissions with their dates, rates and submitters, and attaches the interview", async () => {
    const dry = await commitBatch(imp, batchId, { dryRun: true });
    expect(dry.failures, JSON.stringify(dry.failures)).toEqual([]);
    const c = await commitBatch(imp, batchId, { dryRun: false });
    expect(c.failures).toEqual([]);
    expect(c.loaded).toEqual({ candidates: 3, submissions: 4, interviews: 1, placements: 0, updated: 0 });
    expect(dry.loaded).toEqual(c.loaded);

    const subs = (await db.admin.query<{ first: string; client: string; vendor: string; rate: string; day: string; recruiter: string; team: string; status: string }>(
      `SELECT p.first_name AS first, cl.name AS client, v.name AS vendor, s.rate::text AS rate,
              to_char(s.submitted_at AT TIME ZONE 'America/Chicago', 'YYYY-MM-DD HH24:MI') AS day,
              s.recruiter_id AS recruiter, s.team_id AS team, s.status
         FROM eureka.submission s JOIN eureka.candidate ca ON ca.id = s.candidate_id JOIN eureka.person p ON p.id = ca.person_id
         JOIN eureka.client cl ON cl.id = s.client_id LEFT JOIN eureka.vendor v ON v.id = s.vendor_id
        ORDER BY s.submitted_at`)).rows;
    expect(subs).toEqual([
      { first: "Asha", client: "Northwind Financial", vendor: "northwind staffing", rate: "65.00", day: "2026-08-03 12:00", recruiter: U.r1a, team: T.t1, status: "submitted" },
      { first: "Asha", client: "Woodgrove Bank", vendor: "Fabrikam", rate: "70.00", day: "2026-08-04 12:00", recruiter: U.r1a, team: T.t1, status: "submitted" },
      // Another team's recruiter submits the shared candidate.
      { first: "Asha", client: "Fourth Coffee", vendor: "tailspin", rate: "66.00", day: "2026-08-05 12:00", recruiter: U.r2a, team: T.t2, status: "submitted" },
      // Spellings differing only in case are one vendor (the first one loaded names it).
      { first: "Ben", client: "Proseware - 3/12", vendor: "Fabrikam", rate: "60.00", day: "2026-08-20 12:00", recruiter: U.r1b, team: T.t1, status: "interview_completed" },
    ]);
    const iv = (await db.admin.query<{ round: string; starts: string; call_status: string; recruiter: string }>(
      `SELECT i.round, to_char(i.starts_at AT TIME ZONE 'America/Chicago', 'YYYY-MM-DD HH24:MI') AS starts, i.call_status, i.recruiter_id AS recruiter
         FROM eureka.interview i`)).rows;
    expect(iv).toEqual([{ round: "L1", starts: "2026-08-25 10:00", call_status: "completed", recruiter: U.r1b }]);
    const cand = (await db.admin.query<{ visibility: string; team_id: string; marketing_status: string }>(
      `SELECT c.visibility, c.team_id, c.marketing_status FROM eureka.candidate c JOIN eureka.person p ON p.id = c.person_id WHERE p.first_name = 'Asha'`)).rows;
    expect(cand).toEqual([{ visibility: "all_teams", team_id: T.t1, marketing_status: "active" }]);
    // New reference rows are audited by id only.
    const audit = (await db.admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM eureka.audit_event WHERE action IN ('client.created', 'vendor.created') AND changes ->> 'source' = 'import'`)).rows[0]!.n;
    expect(audit).toBe(6);
  });

  it("a later workbook with the same rows loads nothing twice", async () => {
    const s = await stageWorkbook();
    expect(s.created).toBe(true);
    const rep = await reconcile(imp, s.batchId);
    expect(rep.sheets.sales.skipped).toBe(3);
    expect(rep.sheets.submissions.skipped).toBe(4);
    expect(rep.sheets.interviews.skipped).toBe(1);
  });

  it("the definer adds reference rows only while an import loads", async () => {
    const c = await db.admin.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL ROLE authz_definer");
      await expect(c.query(`INSERT INTO eureka.client (name) VALUES ('Sneaky Corp')`)).rejects.toThrow(/server_managed_field/);
    } finally {
      await c.query("ROLLBACK");
      c.release();
    }
    await expect(imp.query(`INSERT INTO eureka.client (name) VALUES ('Sneaky Corp')`)).rejects.toThrow(/permission denied/);
  });
});

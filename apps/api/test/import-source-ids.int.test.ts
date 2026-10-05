/**
 * C1a.2 (docs/crewnex-consolidation.md section 6, D3): in a `crewnex` batch a
 * row is keyed by its CrewNex id, so its review decision survives edits in a
 * later export and the ledger skips it once loaded; a person's identity is
 * the CrewNex consultant id (never the reissued marketing email). Sheet
 * batches are untouched (src/import/sheets-golden.test.ts pins them).
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.module.js";
import { identityHashes, makeHmac, rowKeyOf, sourceRowKey } from "../src/import/analyze.js";
import { commitBatch } from "../src/import/commit.js";
import { listReview } from "../src/import/review.js";
import { recompute, stage } from "../src/import/stage.js";
import { loadConfig } from "../src/platform/config.js";
import { createTestDb, type TestDb } from "./db-harness.js";
import { U, seedFixtures } from "./fixtures.js";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures/import");
const MAPPING = readFileSync(join(DIR, "mapping.json"), "utf8");
const MAPPING_CN = JSON.stringify((() => {
  const m = JSON.parse(MAPPING);
  for (const sheet of ["sales", "interviews", "placements"]) m.sheets[sheet].columns.sourceId = "Source Id";
  for (const sheet of ["interviews", "placements"]) m.sheets[sheet].columns.consultantSourceId = "Consultant Id";
  return m;
})());
const ADMIN_BASE = process.env.TEST_PG_ADMIN_URL ?? "postgres://postgres:postgres@127.0.0.1:5432";
const hmac = makeHmac("test-import-hmac-key-test-import-hmac-key");
const TMP = mkdtempSync(join(tmpdir(), "eureka-source-ids-"));

let db: TestDb;
let imp: pg.Pool;
let app: NestFastifyApplication;

beforeAll(async () => {
  db = await createTestDb();
  await seedFixtures(db.admin);
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
async function call(key: keyof typeof U, method: "GET" | "POST", url: string, payload?: unknown) {
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
const decide = (id: string, body: Record<string, unknown>) => call("admin", "POST", `/api/v1/imports/${id}/decisions`, body);

async function crewnexCommit(on: boolean) {
  await db.admin.query(on
    ? `INSERT INTO authz.policy_setting (key, value) VALUES ('crewnex_commit', 'on') ON CONFLICT (key) DO UPDATE SET value = 'on'`
    : `DELETE FROM authz.policy_setting WHERE key = 'crewnex_commit'`);
}
/** Second-admin approval and the one commit, with the CrewNex switch on for the duration (C1f's job in production). */
async function approveAndCommit(id: string) {
  await crewnexCommit(true);
  try {
    const p = (await call("admin2", "GET", `/api/v1/imports/${id}/preview`)).json();
    expect(p.problems).toEqual([]);
    expect((await call("admin2", "POST", `/api/v1/imports/${id}/approve`, { digest: p.digest })).statusCode).toBe(200);
    const r = await commitBatch(imp, id, { dryRun: false });
    expect(r.failures).toEqual([]);
    return r;
  } finally {
    await crewnexCommit(false);
  }
}

const SALES_HEADER = "First Name,Last Name,Personal Email,Marketing Email,Phone,DOB,Technology,Location,Recruiter Email,Status,Row Color,Priority,Marketing Start Date";
const IV_HEADER = "Candidate Name,Candidate Email,Phone,DOB,Recruiter Email,Client,Vendor,Job Title,Round,Interview Date,Start Time,End Time,Duration (min),Time Zone,Call Status,Row Color";
interface Person { first: string; last: string; personal?: string; marketing?: string; phone?: string; priority?: string; src?: string }
const salesLine = (p: Person) =>
  `${p.first},${p.last},${p.personal ?? ""},${p.marketing ?? ""},${p.phone ?? ""},,Java,Dallas,r1a@eureka.example,Active,,${p.priority ?? ""},,${p.src ?? ""}`;
let fileNo = 0;
function csv(header: string, lines: string[]): string {
  const p = join(TMP, `f${++fileNo}.csv`);
  writeFileSync(p, `${header},Source Id${header === IV_HEADER ? ",Consultant Id" : ""}\n${lines.join("\n")}\n`);
  return p;
}
const salesCsv = (people: Person[]) => csv(SALES_HEADER, people.map(salesLine));

const rowsOf = async (id: string) => (await db.admin.query<{ sheet: string; row_no: number; row_key: string; state: string; reasons: string[]; person_key: string | null }>(
  `SELECT sheet, row_no, row_key, state, reasons, person_key FROM eureka.import_row WHERE batch_id = $1 ORDER BY sheet, row_no`, [id])).rows;
const row = async (id: string, sheet: string, rowNo: number) => (await rowsOf(id)).find((r) => r.sheet === sheet && r.row_no === rowNo)!;

describe("crewnex row keys (C1a.2)", () => {
  it("a crewnex row keeps its key and its review decision after a cell edit, across re-analysis and a new export", async () => {
    const before = salesCsv([{ first: "Zora", last: "Quill", personal: "zora.q@example.com", phone: "12", priority: "P1", src: "cn_zora" }]);
    const a = await stage(imp, { sales: before }, MAPPING_CN, { hmac, ticket: await ticket(), source: "crewnex" });
    const key = sourceRowKey("sales", "cn_zora", hmac);
    expect(await row(a.batchId, "sales", 2)).toMatchObject({ row_key: key, state: "review", reasons: ["invalid_phone:phone"] });
    expect((await decide(a.batchId, { sheet: "sales", rowNo: 2, action: "approve" })).statusCode).toBe(200);
    await recompute(imp, a.batchId, hmac);
    expect(await row(a.batchId, "sales", 2)).toMatchObject({ row_key: key, state: "clean", reasons: [] });

    // The next export: the same consultant with edited cells, on another sheet row.
    const edited = salesCsv([{ first: "Ann", last: "Other", phone: "214-555-0181", src: "cn_other" },
      { first: "Zora", last: "Quill-Ames", personal: "zora.q@example.com", phone: "12", priority: "P2", src: "cn_zora" }]);
    const b = await stage(imp, { sales: edited }, MAPPING_CN, { hmac, ticket: await ticket(), source: "crewnex" });
    expect(b.batchId).not.toBe(a.batchId);
    expect(await row(b.batchId, "sales", 3)).toMatchObject({ row_key: key, state: "clean", reasons: [] });
    // Re-staging the same export re-analyses it in place: still the same key and decision.
    expect((await stage(imp, { sales: edited }, MAPPING_CN, { hmac, source: "crewnex" })).batchId).toBe(b.batchId);
    expect(await row(b.batchId, "sales", 3)).toMatchObject({ row_key: key, state: "clean" });

    // A sheet batch of the same edit keys by the cells: a new row, the decision does not follow it.
    const sh = await stage(imp, { sales: edited }, MAPPING, { hmac, ticket: await ticket() });
    const shRow = await row(sh.batchId, "sales", 3);
    expect(shRow.row_key).not.toBe(key);
    expect(shRow).toMatchObject({ state: "review", reasons: ["invalid_phone:phone"] });
    const cells = { "First Name": "Zora", "Last Name": "Quill-Ames", "Personal Email": "zora.q@example.com", Phone: "12", Technology: "Java",
      Location: "Dallas", "Recruiter Email": "r1a@eureka.example", Status: "Active", Priority: "P2", "Source Id": "cn_zora" };
    expect(shRow.row_key).toBe(rowKeyOf("sales", cells, hmac));
  });

  it("missing and duplicate CrewNex ids go to review, cannot be approved, and an unmapped id column stops staging", async () => {
    const f = salesCsv([
      { first: "Mae", last: "Blank", phone: "214-555-0191" },
      { first: "Dup", last: "One", phone: "214-555-0192", src: "cn_dup" },
      { first: "Dup", last: "Two", phone: "214-555-0193", src: "cn_dup" },
    ]);
    const s = await stage(imp, { sales: f }, MAPPING_CN, { hmac, ticket: await ticket(), source: "crewnex" });
    const rs = await rowsOf(s.batchId);
    expect(rs.map((r) => [r.row_no, r.state, r.reasons.filter((x) => x.includes("source_id"))])).toEqual([
      [2, "review", ["missing_source_id"]], [3, "review", ["duplicate_source_id"]], [4, "review", ["duplicate_source_id"]]]);
    expect((await listReview(imp, s.batchId)).map((i) => i.approvable)).toEqual([false, false, false]);
    for (const rowNo of [2, 3]) {
      expect((await decide(s.batchId, { sheet: "sales", rowNo, action: "approve" })).json().detail).toBe("not_approvable");
    }
    // The mapping must name the column, and the export must carry it.
    await expect(stage(imp, { sales: f }, MAPPING, { hmac, ticket: await ticket(), source: "crewnex" }))
      .rejects.toThrow(/a crewnex batch needs sheets\.sales\.columns\.sourceId/);
    const noCol = join(TMP, "no-source-col.csv");
    writeFileSync(noCol, `${SALES_HEADER}\nNo,Column,,,214-555-0194,,Java,Dallas,r1a@eureka.example,Active,,,\n`);
    await expect(stage(imp, { sales: noCol }, MAPPING_CN, { hmac, ticket: await ticket(), source: "crewnex" }))
      .rejects.toThrow(/missing column\(s\) "Source Id"/);
    // Interview and placement exports must name the consultant's id too (mapping and column).
    const ivNoConsultant = join(TMP, "iv-no-consultant.csv");
    writeFileSync(ivNoConsultant, `${IV_HEADER},Source Id\nX Y,,,,r1a@eureka.example,Northwind Financial,,Java Developer,L1,2026-09-01,10:00 AM,,60,CST,Completed,,iv_x\n`);
    await expect(stage(imp, { interviews: ivNoConsultant }, MAPPING_CN, { hmac, ticket: await ticket(), source: "crewnex" }))
      .rejects.toThrow(/missing column\(s\) "Consultant Id"/);
    const noMap = JSON.parse(MAPPING_CN);
    delete noMap.sheets.interviews.columns.consultantSourceId;
    await expect(stage(imp, { interviews: ivNoConsultant }, JSON.stringify(noMap), { hmac, ticket: await ticket(), source: "crewnex" }))
      .rejects.toThrow(/needs sheets\.interviews\.columns\.consultantSourceId/);
  });
});

describe("crewnex identity (C1a.2, D3)", () => {
  it("a consultant id in the ledger is skipped in a later batch, and its new activity attaches to the loaded candidate", async () => {
    const first = await stage(imp, { sales: salesCsv([{ first: "Lena", last: "Moss", personal: "lena.m@example.com", marketing: "lena@mktg.example",
      phone: "214-555-0171", src: "cn_lena" }]) }, MAPPING_CN, { hmac, ticket: await ticket(), source: "crewnex" });
    expect((await approveAndCommit(first.batchId)).loaded.candidates).toBe(1);
    const cand = (await db.admin.query<{ entity_id: string }>(
      `SELECT entity_id FROM eureka.import_link WHERE sheet = 'sales' AND row_key = $1`, [sourceRowKey("sales", "cn_lena", hmac)])).rows[0]!.entity_id;
    const ids = (await db.admin.query<{ identity_hash: string }>(
      `SELECT identity_hash FROM eureka.import_identity WHERE candidate_id = $1`, [cand])).rows.map((r) => r.identity_hash);
    const hashes = (o: Partial<Parameters<typeof identityHashes>[0]>) =>
      identityHashes({ emails: [], phone: null, nameKey: null, dob: null, ...o }, hmac);
    expect(ids).toContain(hashes({ source: "cn_lena" }).source);
    expect(ids).toContain(hashes({ emails: ["lena.m@example.com"] }).emails[0]);
    expect(ids).not.toContain(hashes({ emails: ["lena@mktg.example"] }).emails[0]); // marketing email is not identity

    // The next export: Lena edited, plus an interview that names her only by her CrewNex id.
    const later = await stage(imp, {
      sales: salesCsv([{ first: "Lena", last: "Moss", personal: "lena.m@example.com", phone: "214-555-0171", priority: "P3", src: "cn_lena" }]),
      interviews: csv(IV_HEADER, ["Someone Else,,,,r1a@eureka.example,Northwind Financial,,Java Developer,L1,2026-09-01,10:00 AM,,60,CST,Completed,,iv_lena_1,cn_lena"]),
    }, MAPPING_CN, { hmac, ticket: await ticket(), source: "crewnex" });
    expect(await row(later.batchId, "sales", 2)).toMatchObject({ state: "skipped", reasons: ["already_imported"], person_key: `ledger:${cand}` });
    expect(await row(later.batchId, "interviews", 2)).toMatchObject({ state: "clean", reasons: [], person_key: `ledger:${cand}` });
    const dry = await commitBatch(imp, later.batchId, { dryRun: true });
    expect([dry.failures, dry.loaded.candidates, dry.loaded.interviews]).toEqual([[], 0, 1]);
  });

  it("two CrewNex consultants sharing a marketing email stay two people, in one batch and across batches", async () => {
    const people: Person[] = [
      { first: "Ines", last: "Varga", personal: "ines.v@example.com", marketing: "shared@mktg.example", phone: "214-555-0161", src: "cn_ines" },
      { first: "Omar", last: "Haddad", personal: "omar.h@example.com", marketing: "shared@mktg.example", phone: "214-555-0162", src: "cn_omar" },
    ];
    const f = salesCsv(people);
    const s = await stage(imp, { sales: f }, MAPPING_CN, { hmac, ticket: await ticket(), source: "crewnex" });
    const rs = await rowsOf(s.batchId);
    expect(rs.map((r) => [r.state, r.reasons, r.person_key === r.row_key])).toEqual([["clean", [], true], ["clean", [], true]]);
    // The sheet rule, for contrast: the same file as a sheet batch makes them one person.
    const sh = await stage(imp, { sales: f }, MAPPING, { hmac, ticket: await ticket() });
    expect(await row(sh.batchId, "sales", 3)).toMatchObject({ state: "review", reasons: ["probable_duplicate"] });

    expect((await approveAndCommit(s.batchId)).loaded.candidates).toBe(2);
    // A third consultant later inherits the reissued address: a new person, not "already imported".
    const later = await stage(imp, { sales: salesCsv([{ first: "Pia", last: "Lund", personal: "pia.l@example.com", marketing: "shared@mktg.example",
      phone: "214-555-0163", src: "cn_pia" }]) }, MAPPING_CN, { hmac, ticket: await ticket(), source: "crewnex" });
    const pia = await row(later.batchId, "sales", 2);
    expect(pia).toMatchObject({ state: "clean", reasons: [] });
    expect(pia.person_key).toBe(pia.row_key);
    expect((await commitBatch(imp, later.batchId, { dryRun: true })).loaded.candidates).toBe(1);
  });
});

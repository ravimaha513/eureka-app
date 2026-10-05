/**
 * C1a.3 (docs/crewnex-consolidation.md section 6): a batch's source and
 * historical flag are fixed when it opens, immutable, part of the approval
 * digest, and the loader knows the mode in a dry run as well as in a commit.
 */
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.module.js";
import { makeHmac } from "../src/import/analyze.js";
import { commitBatch } from "../src/import/commit.js";
import { stage } from "../src/import/stage.js";
import { migrate, seedCatalog } from "../src/db/migrate.js";
import { loadConfig } from "../src/platform/config.js";
import { createTestDb, type TestDb } from "./db-harness.js";
import { U, seedFixtures } from "./fixtures.js";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures/import");
const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "../../../db/migrations");
const MAPPING = readFileSync(join(DIR, "mapping.json"), "utf8");
const ADMIN_BASE = process.env.TEST_PG_ADMIN_URL ?? "postgres://postgres:postgres@127.0.0.1:5432";
const hmac = makeHmac("test-import-hmac-key-test-import-hmac-key");
const TMP = mkdtempSync(join(tmpdir(), "eureka-batch-source-"));

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

/** A one-person sales sheet (one clean row), distinct per name so each stage opens its own batch. */
let seq = 0;
function oneSales(): string {
  const n = ++seq;
  const header = readFileSync(join(DIR, "sales.csv"), "utf8").split("\n")[0]!;
  const p = join(TMP, `sales_${n}.csv`);
  const name = `Dee${"abcdefghijklmnop"[n]}`;
  writeFileSync(p, `${header}\n${name},Gee,${name.toLowerCase()}.g@example.com,,(214) 555-01${String(10 + n)},,Java,Dallas,r1a@eureka.example,Active,,,\n`);
  return p;
}
const batch = async (id: string) => (await db.admin.query<{ source: string; historical: boolean; status: string }>(
  `SELECT source, historical, status FROM eureka.import_batch WHERE id = $1`, [id])).rows[0]!;
const digestOf = async (id: string) => (await db.admin.query<{ d: string }>(`SELECT authz.import_batch_digest($1) AS d`, [id])).rows[0]!.d;
/** Changes a flag behind the guard's back (superuser, triggers off): what the digest must notice. */
async function tamper(id: string, set: string) {
  const c = await db.admin.connect();
  try {
    await c.query("BEGIN");
    await c.query("SET LOCAL session_replication_role = replica");
    await c.query(`UPDATE eureka.import_batch SET ${set} WHERE id = $1`, [id]);
    await c.query("COMMIT");
  } finally {
    c.release();
  }
}
/** One person's load in a dry run, as the CLI calls it; returns the function's report. */
async function dryRunOne(id: string): Promise<{ historical: boolean; counts: Record<string, number> }> {
  const row = (await imp.query<{ id: string }>(
    `SELECT id FROM eureka.import_row WHERE batch_id = $1 AND sheet = 'sales' AND state = 'clean' ORDER BY row_no LIMIT 1`, [id])).rows[0]!;
  const c = await imp.connect();
  try {
    await c.query("BEGIN");
    await c.query(`SELECT authz.import_load_person($1, $2, true)`, [id, row.id]);
    throw new Error("a dry run must roll back");
  } catch (err) {
    const e = err as { message: string; detail?: string };
    if (e.message !== "import_dry_run") throw err;
    return JSON.parse(e.detail!);
  } finally {
    await c.query("ROLLBACK");
    c.release();
  }
}

describe("batch source and historical (C1a.3)", () => {
  it("a batch staged as before is source 'sheets', not historical, and loads as before", async () => {
    const s = await stage(imp, { sales: oneSales() }, MAPPING, { hmac, ticket: await ticket() });
    expect(await batch(s.batchId)).toMatchObject({ source: "sheets", historical: false });
    expect(await dryRunOne(s.batchId)).toMatchObject({ historical: false, counts: { candidates: 1 } });
    const p = (await call("admin2", "GET", `/api/v1/imports/${s.batchId}/preview`)).json();
    expect(p).toMatchObject({ source: "sheets", historical: false, placementsCommit: true }); // the fixture mapping loads placements
    expect((await call("admin2", "POST", `/api/v1/imports/${s.batchId}/approve`, { digest: p.digest })).statusCode).toBe(200);
    const r = await commitBatch(imp, s.batchId, { dryRun: false });
    expect([r.failures, r.loaded.candidates]).toEqual([[], 1]);
    expect((await batch(s.batchId)).status).toBe("committed");
  });

  it("source and historical are recorded at stage, shown in the preview, and drive import_historical() in a dry run", async () => {
    const s = await stage(imp, { sales: oneSales() }, MAPPING, { hmac, ticket: await ticket(), source: "crewnex", historical: true });
    expect(await batch(s.batchId)).toMatchObject({ source: "crewnex", historical: true });
    expect((await call("admin2", "GET", `/api/v1/imports/${s.batchId}/preview`)).json())
      .toMatchObject({ source: "crewnex", historical: true });
    // Historical mode holds in the dry run (verified_batch is set only when committing).
    expect(await dryRunOne(s.batchId)).toMatchObject({ historical: true, counts: { candidates: 1 } });
    // Outside an import call it is false, and no login role may call it.
    expect((await db.admin.query(`SELECT authz.import_historical() AS h`)).rows[0].h).toBe(false);
    await expect(imp.query(`SELECT authz.import_historical()`)).rejects.toThrow(/permission denied/);
    await expect(db.app.query(`SELECT authz.import_historical()`)).rejects.toThrow(/permission denied/);
    // A source the database does not know is refused when the batch opens.
    await expect(imp.query(`SELECT authz.import_open_batch($1, repeat('b', 64), '{}', false, 'excel', false)`, [await ticket()]))
      .rejects.toThrow(/import_batch_source/);
  });

  it("neither flag can be changed after staging: not by the CLI role, the app role, the definer or a superuser", async () => {
    const s = await stage(imp, { sales: oneSales() }, MAPPING, { hmac, ticket: await ticket() });
    for (const set of ["source = 'crewnex'", "historical = true"]) {
      await expect(imp.query(`UPDATE eureka.import_batch SET ${set} WHERE id = $1`, [s.batchId])).rejects.toThrow(/permission denied/);
      await expect(db.app.query(`UPDATE eureka.import_batch SET ${set} WHERE id = $1`, [s.batchId])).rejects.toThrow(/permission denied/);
      const c = await db.admin.connect();
      try {
        await c.query("BEGIN");
        await c.query("SET LOCAL ROLE authz_definer"); // the loader's owner: no column privilege
        await expect(c.query(`UPDATE eureka.import_batch SET ${set} WHERE id = $1`, [s.batchId])).rejects.toThrow(/permission denied/);
      } finally {
        await c.query("ROLLBACK");
        c.release();
      }
      // A superuser has every privilege and bypasses RLS: the guard still refuses.
      await expect(db.admin.query(`UPDATE eureka.import_batch SET ${set} WHERE id = $1`, [s.batchId])).rejects.toThrow(/column is immutable/);
    }
    expect(await batch(s.batchId)).toMatchObject({ source: "sheets", historical: false });
    // Re-staging the same files with other settings opens a new batch, never re-analyses this one.
    const again = await stage(imp, { sales: join(TMP, `sales_${seq}.csv`) }, MAPPING, { hmac, ticket: await ticket(), historical: true });
    expect(again.created).toBe(true);
    expect(again.batchId).not.toBe(s.batchId);
  });

  it("the digest covers both flags: an approval quoting the old digest is refused, and so is a commit", async () => {
    const s = await stage(imp, { sales: oneSales() }, MAPPING, { hmac, ticket: await ticket() });
    const d0 = await digestOf(s.batchId);
    expect((await call("admin2", "GET", `/api/v1/imports/${s.batchId}/preview`)).json().digest).toBe(d0);
    await tamper(s.batchId, "historical = true");
    const d1 = await digestOf(s.batchId);
    expect(d1).not.toBe(d0);
    const r = await call("admin2", "POST", `/api/v1/imports/${s.batchId}/approve`, { digest: d0 });
    expect([r.statusCode, r.json().detail]).toEqual([409, "batch_changed"]);
    await tamper(s.batchId, "historical = false, source = 'crewnex'");
    expect(await digestOf(s.batchId)).not.toBe(d0);
    expect(await digestOf(s.batchId)).not.toBe(d1);
    await tamper(s.batchId, "source = 'sheets'");
    expect(await digestOf(s.batchId)).toBe(d0);

    // Approved, then a flag changes: the loader refuses the commit.
    expect((await call("admin2", "POST", `/api/v1/imports/${s.batchId}/approve`, { digest: d0 })).statusCode).toBe(200);
    await tamper(s.batchId, "historical = true");
    const c = await commitBatch(imp, s.batchId, { dryRun: false });
    expect(c.failures.map((f) => f.error)).toEqual([expect.stringMatching(/batch_changed/)]);
    expect(c.loaded.candidates).toBe(0);
  });
});

describe("migration 0054 on a database with batches", () => {
  it("withdraws approvals given under the old digest formula; staged and committed batches keep theirs", async () => {
    const name = `eureka_test_0054_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const root = new pg.Client({ connectionString: `${ADMIN_BASE}/postgres` });
    await root.connect();
    await root.query(`CREATE DATABASE ${name}`);
    const c = new pg.Client({ connectionString: `${ADMIN_BASE}/${name}` });
    await c.connect();
    try {
      // Up to 0053, applied and recorded as migrate() does it.
      await c.query(`CREATE TABLE public.schema_migration (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
      for (const f of readdirSync(MIGRATIONS).filter((x) => x.endsWith(".sql") && x < "0054").sort()) {
        await c.query("BEGIN");
        await c.query(readFileSync(join(MIGRATIONS, f), "utf8"));
        await c.query("RESET ROLE");
        await c.query("INSERT INTO public.schema_migration (name) VALUES ($1)", [f]);
        await c.query("COMMIT");
      }
      await seedCatalog(c);
      const pool = new pg.Pool({ connectionString: `${ADMIN_BASE}/${name}`, max: 1 });
      await seedFixtures(pool);
      await pool.end();
      // Batches as 0041 left them (triggers off: these stand for rows written over time).
      await c.query("BEGIN");
      await c.query("SET LOCAL session_replication_role = replica");
      const ins = async (status: string) => (await c.query<{ id: string }>(
        `INSERT INTO eureka.import_batch (source_digest, files, operator_id, status, approved_by, approved_at, approved_digest)
         VALUES (encode(sha256(random()::text::bytea), 'hex'), '{}', $1, $2, $3, $4, $5) RETURNING id`,
        [U.admin, status, ...(status === "staged" ? [null, null, null] : [U.admin2, new Date(), "0".repeat(64)])])).rows[0]!.id;
      const staged = await ins("staged");
      const approved = await ins("approved");
      const committed = await ins("committed");
      await c.query(`UPDATE eureka.import_batch SET approved_digest = authz.import_batch_digest(id) WHERE status <> 'staged'`);
      await c.query("COMMIT");
      const oldDigest = (await c.query<{ d: string }>(`SELECT approved_digest AS d FROM eureka.import_batch WHERE id = $1`, [committed])).rows[0]!.d;

      await migrate(`${ADMIN_BASE}/${name}`, { production: false });

      const after = new Map((await c.query<{ id: string; status: string; approved_by: string | null; approved_digest: string | null; source: string; historical: boolean }>(
        `SELECT id, status, approved_by, approved_digest, source, historical FROM eureka.import_batch`)).rows.map((r) => [r.id, r]));
      expect(after.get(approved)).toMatchObject({ status: "staged", approved_by: null, approved_digest: null, source: "sheets", historical: false });
      expect(after.get(staged)).toMatchObject({ status: "staged", approved_digest: null });
      expect(after.get(committed)).toMatchObject({ status: "committed", approved_digest: oldDigest });
      // The formula did change: the same batch hashes differently now.
      expect((await c.query<{ d: string }>(`SELECT authz.import_batch_digest($1) AS d`, [committed])).rows[0]!.d).not.toBe(oldDigest);
    } finally {
      await c.end();
      await root.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await root.end();
    }
  }, 120_000);
});

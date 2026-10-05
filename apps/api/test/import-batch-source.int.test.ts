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
import { run } from "../src/import/cli.js";
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
/** The fixture mapping plus the CrewNex id column a crewnex batch requires (C1a.2). */
const MAPPING_CN_PATH = join(TMP, "mapping.crewnex.json");
const MAPPING_CN = JSON.stringify((() => {
  const m = JSON.parse(MAPPING);
  for (const sheet of ["sales", "interviews", "placements"]) m.sheets[sheet].columns.sourceId = "Source Id";
  return m;
})());
writeFileSync(MAPPING_CN_PATH, MAPPING_CN);

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

/**
 * A one-person sales sheet (one clean row), distinct per name so each stage
 * opens its own batch. It carries a CrewNex id, which a sheet batch ignores.
 */
let seq = 0;
function oneSales(): string {
  const n = ++seq;
  const header = readFileSync(join(DIR, "sales.csv"), "utf8").split("\n")[0]!;
  const p = join(TMP, `sales_${n}.csv`);
  const name = `Dee${"abcdefghijklmnop"[n]}`;
  writeFileSync(p, `${header},Source Id\n${name},Gee,${name.toLowerCase()}.g@example.com,,(214) 555-01${String(10 + n)},,Java,Dallas,r1a@eureka.example,Active,,,,cn_${n}\n`);
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
/** authz.policy_setting crewnex_commit (absent = off): what C1f will turn on. */
async function crewnexCommit(on: boolean) {
  await db.admin.query(on
    ? `INSERT INTO authz.policy_setting (key, value) VALUES ('crewnex_commit', 'on') ON CONFLICT (key) DO UPDATE SET value = 'on'`
    : `DELETE FROM authz.policy_setting WHERE key = 'crewnex_commit'`);
}
async function withCrewnexCommit<T>(fn: () => Promise<T>): Promise<T> {
  await crewnexCommit(true);
  try { return await fn(); } finally { await crewnexCommit(false); }
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
    const s = await stage(imp, { sales: oneSales() }, MAPPING_CN, { hmac, ticket: await ticket(), source: "crewnex", historical: true });
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
    // Historical replay is for CrewNex batches only: refused by stage() and by the database.
    await expect(stage(imp, { sales: oneSales() }, MAPPING, { hmac, ticket: await ticket(), historical: true }))
      .rejects.toThrow(/--historical needs --source crewnex/);
    await expect(imp.query(`SELECT authz.import_open_batch($1, repeat('c', 64), '{}', false, 'sheets', true)`, [await ticket()]))
      .rejects.toThrow(/import_batch_historical/);
  });

  it("a CrewNex batch dry-runs, but approval and commit are refused until the crewnex_commit switch is on", async () => {
    const s = await stage(imp, { sales: oneSales() }, MAPPING_CN, { hmac, ticket: await ticket(), source: "crewnex" });
    expect(await dryRunOne(s.batchId)).toMatchObject({ historical: false, counts: { candidates: 1 } });
    // Approval: the verification reports the problem and refuses.
    const p = (await call("admin2", "GET", `/api/v1/imports/${s.batchId}/preview`)).json();
    expect(p.problems).toEqual([{ sheet: "sales", rowNo: 2, problem: "crewnex_commit_disabled" }]);
    const a = await call("admin2", "POST", `/api/v1/imports/${s.batchId}/approve`, { digest: p.digest });
    expect([a.statusCode, a.json().detail]).toEqual([422, "verification_failed"]);
    // Commit: approved while the switch was on, then switched off: the loader refuses on its own.
    await withCrewnexCommit(async () => {
      const q = (await call("admin2", "GET", `/api/v1/imports/${s.batchId}/preview`)).json();
      expect(q.problems).toEqual([]);
      expect((await call("admin2", "POST", `/api/v1/imports/${s.batchId}/approve`, { digest: q.digest })).statusCode).toBe(200);
    });
    const before = (await db.admin.query(`SELECT count(*)::int AS n FROM eureka.candidate`)).rows[0].n;
    const refused = await commitBatch(imp, s.batchId, { dryRun: false });
    expect(refused.failures.map((f) => f.error)).toEqual([expect.stringMatching(/crewnex_commit_disabled/)]);
    expect((await db.admin.query(`SELECT count(*)::int AS n FROM eureka.candidate`)).rows[0].n).toBe(before);
    // A dry run of the approved batch still works with the switch off.
    expect((await commitBatch(imp, s.batchId, { dryRun: true })).failures).toEqual([]);
    // With the switch on it commits.
    const done = await withCrewnexCommit(() => commitBatch(imp, s.batchId, { dryRun: false }));
    expect([done.failures, done.loaded.candidates]).toEqual([[], 1]);
    // No role but the migration owner can flip the switch.
    for (const pool of [imp, db.app]) {
      await expect(pool.query(`INSERT INTO authz.policy_setting (key, value) VALUES ('crewnex_commit', 'on')`)).rejects.toThrow(/permission denied/);
    }
    await expect(db.admin.query(`INSERT INTO authz.policy_setting (key, value) VALUES ('crewnex_commit', 'yes')`))
      .rejects.toThrow(/policy_setting_crewnex_commit/);
  });

  it("neither flag can be changed after staging: not by the CLI role, the app role, the definer or a superuser", async () => {
    const s = await stage(imp, { sales: oneSales() }, MAPPING_CN, { hmac, ticket: await ticket(), source: "crewnex" });
    for (const set of ["source = 'sheets'", "historical = true"]) {
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
      // A superuser has every privilege and bypasses RLS: the guard still refuses (short of disabling triggers).
      await expect(db.admin.query(`UPDATE eureka.import_batch SET ${set} WHERE id = $1`, [s.batchId])).rejects.toThrow(/column is immutable/);
    }
    expect(await batch(s.batchId)).toMatchObject({ source: "crewnex", historical: false });
    // Re-staging the same files with other settings opens a new batch, never re-analyses this one.
    const again = await stage(imp, { sales: join(TMP, `sales_${seq}.csv`) }, MAPPING_CN, { hmac, ticket: await ticket(), source: "crewnex", historical: true });
    expect(again.created).toBe(true);
    expect(again.batchId).not.toBe(s.batchId);
  });

  it("the digest covers both flags: an approval quoting the old digest is refused, and so is a commit", async () => {
    await crewnexCommit(true); // isolates the digest from the switch's verification problem
    try {
      const s = await stage(imp, { sales: oneSales() }, MAPPING_CN, { hmac, ticket: await ticket(), source: "crewnex" });
      const d0 = await digestOf(s.batchId);
      expect((await call("admin2", "GET", `/api/v1/imports/${s.batchId}/preview`)).json().digest).toBe(d0);
      await tamper(s.batchId, "historical = true");
      const d1 = await digestOf(s.batchId);
      expect(d1).not.toBe(d0);
      const r = await call("admin2", "POST", `/api/v1/imports/${s.batchId}/approve`, { digest: d0 });
      expect([r.statusCode, r.json().detail]).toEqual([409, "batch_changed"]);
      await tamper(s.batchId, "historical = false, source = 'sheets'");
      expect(await digestOf(s.batchId)).not.toBe(d0);
      expect(await digestOf(s.batchId)).not.toBe(d1);
      await tamper(s.batchId, "source = 'crewnex'");
      expect(await digestOf(s.batchId)).toBe(d0);

      // Approved, then a flag changes: the loader refuses the commit.
      expect((await call("admin2", "POST", `/api/v1/imports/${s.batchId}/approve`, { digest: d0 })).statusCode).toBe(200);
      await tamper(s.batchId, "historical = true");
      const c = await commitBatch(imp, s.batchId, { dryRun: false });
      expect(c.failures.map((f) => f.error)).toEqual([expect.stringMatching(/batch_changed/)]);
      expect(c.loaded.candidates).toBe(0);
    } finally {
      await crewnexCommit(false);
    }
  });
});

describe("CLI: stage --source / --historical", () => {
  const ENV = { IMPORT_HMAC_KEY: "test-import-hmac-key-test-import-hmac-key" };
  const stageCli = async (extra: string[], json = true) => {
    const out: string[] = [];
    const mapping = extra.includes("crewnex") ? MAPPING_CN_PATH : join(DIR, "mapping.json");
    await run(["stage", "--sales", oneSales(), "--mapping", mapping, "--ticket", await ticket(), ...extra,
      ...(json ? ["--json"] : [])], imp, (x) => out.push(x), ENV);
    return out[0]!;
  };

  it("records the flags on the new batch and reports them; the default is sheets, not historical", async () => {
    const plain = JSON.parse(await stageCli([])) as { batchId: string; report: { source: string; historical: boolean } };
    expect(plain.report).toMatchObject({ source: "sheets", historical: false });
    expect(await batch(plain.batchId)).toMatchObject({ source: "sheets", historical: false });
    const cn = JSON.parse(await stageCli(["--source", "crewnex", "--historical"])) as typeof plain;
    expect(cn.report).toMatchObject({ source: "crewnex", historical: true });
    expect(await batch(cn.batchId)).toMatchObject({ source: "crewnex", historical: true });
    expect(await stageCli(["--source", "crewnex"], false)).toMatch(/^source: crewnex {2}historical: no$/m);
  });

  it("refuses an unknown source before opening anything", async () => {
    const n = async () => (await db.admin.query<{ n: number }>(`SELECT count(*)::int AS n FROM eureka.import_batch`)).rows[0]!.n;
    const before = await n();
    await expect(stageCli(["--source", "excel"])).rejects.toThrow(/--source must be one of sheets, crewnex/);
    await expect(stageCli(["--historical"])).rejects.toThrow(/--historical needs --source crewnex/);
    expect(await n()).toBe(before);
  });
});

describe("migration 0054 on a database with batches", () => {
  it("withdraws approvals given under the old digest formula (partly loaded ones too); staged and committed batches keep theirs", async () => {
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
      // Approved and partly loaded: one person committed, one still clean.
      const partial = await ins("approved");
      const loadedEntity = "00000000-0000-4000-8000-0000000000aa";
      await c.query(
        `INSERT INTO eureka.import_row (batch_id, sheet, row_no, row_key, raw, norm, state, committed_entity)
         VALUES ($1, 'sales', 2, repeat('a', 64), '{}', '{}', 'committed', $2), ($1, 'sales', 3, repeat('b', 64), '{}', '{}', 'clean', NULL)`,
        [partial, loadedEntity]);
      await c.query(`UPDATE eureka.import_batch SET approved_digest = authz.import_batch_digest(id) WHERE status <> 'staged'`);
      await c.query("COMMIT");
      const oldDigest = (await c.query<{ d: string }>(`SELECT approved_digest AS d FROM eureka.import_batch WHERE id = $1`, [committed])).rows[0]!.d;

      await migrate(`${ADMIN_BASE}/${name}`, { production: false });

      const after = new Map((await c.query<{ id: string; status: string; approved_by: string | null; approved_digest: string | null; source: string; historical: boolean }>(
        `SELECT id, status, approved_by, approved_digest, source, historical FROM eureka.import_batch`)).rows.map((r) => [r.id, r]));
      expect(after.get(approved)).toMatchObject({ status: "staged", approved_by: null, approved_digest: null, source: "sheets", historical: false });
      expect(after.get(staged)).toMatchObject({ status: "staged", approved_digest: null });
      expect(after.get(committed)).toMatchObject({ status: "committed", approved_digest: oldDigest });
      // The partly loaded batch needs a fresh approval for the rest; what it loaded stays loaded.
      expect(after.get(partial)).toMatchObject({ status: "staged", approved_by: null, approved_digest: null });
      expect((await c.query(`SELECT row_no, state, committed_entity FROM eureka.import_row WHERE batch_id = $1 ORDER BY row_no`, [partial])).rows)
        .toEqual([{ row_no: 2, state: "committed", committed_entity: loadedEntity }, { row_no: 3, state: "clean", committed_entity: null }]);
      // The formula did change: the same batch hashes differently now.
      expect((await c.query<{ d: string }>(`SELECT authz.import_batch_digest($1) AS d`, [committed])).rows[0]!.d).not.toBe(oldDigest);
    } finally {
      await c.end();
      await root.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await root.end();
    }
  }, 120_000);
});

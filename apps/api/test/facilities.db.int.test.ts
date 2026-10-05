import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BlindIndexer } from "../src/platform/crypto/blind-index.js";
import { FieldCipher } from "../src/platform/crypto/field-crypto.js";
import { LocalKeyProvider, LocalMacProvider } from "../src/platform/crypto/key-provider.js";
import { KEY_ROTATION_JOB, keyRotationJob } from "../src/worker/jobs/key-rotation.js";
import { silentLogger } from "../src/worker/log.js";
import { JobRunner } from "../src/worker/runner.js";
import { asUser, createTestDb, type TestDb } from "./db-harness.js";
import { LOC, U, seedFixtures } from "./fixtures.js";
import { joinedEmployee } from "./employee-seed.js";

/**
 * Database checks for migration 0054 with the API removed (design B8): RLS
 * for the app role by location grant, definer-only writes with permission
 * and location re-checks, server-managed columns, minimal EXECUTE grants, and
 * the key rotation of utility passwords as the worker runs it.
 */
let db: TestDb;
let opsA: string;
const users = Object.keys(U) as (keyof typeof U)[];
const apiCipher = new FieldCipher(new LocalKeyProvider());
const workerCipher = new FieldCipher(new LocalKeyProvider());
const macs = new BlindIndexer(new LocalMacProvider());
const thisMonth = () => new Date().toISOString().slice(0, 7);

/** Rows of each kind per location: [Dallas, Austin]. */
const ids = { company: [] as string[], facility: [] as string[], utility: [] as string[], bill: [] as string[] };

async function denied(fn: () => Promise<unknown>): Promise<string> {
  try { await fn(); } catch (err) { return (err as Error).message; }
  return "allowed";
}
const as = <T>(userId: string, sql: string, params: unknown[] = [], commit = true) =>
  asUser(db.app, userId, async (c) => (await c.query<Record<string, T>>(sql, params)).rows, commit);

async function utilityWithPassword(actor: string, kind: "company" | "facility", owner: string, password: string | null): Promise<string> {
  const id = randomUUID();
  await asUser(db.app, actor, async (c) => {
    const sealed = password ? await apiCipher.encrypt(c, { cls: "utility_password", rowId: id }, password) : null;
    const mac = password ? await macs.stretchedIntegrityMac("utility_password", id, password) : null;
    await c.query(`SELECT authz.utility_create($1, $2, $3, 'electricity', 'Fictional Power', NULL, NULL, NULL, $4, $5, $6, NULL)`,
      [id, kind, owner, sealed?.enc ?? null, sealed?.keyId ?? null, mac]);
  }, true);
  return id;
}

beforeAll(async () => {
  db = await createTestDb();
  await seedFixtures(db.admin);
  opsA = (await db.admin.query<{ id: string }>(
    `INSERT INTO eureka.app_user (email, display_name) VALUES ('opsA@eureka.example', 'opsA') RETURNING id`)).rows[0]!.id;
  await db.admin.query(`INSERT INTO eureka.user_role (user_id, role_key, location_id) VALUES ($1, 'location_ops_admin', $2)`, [opsA, LOC.austin]);
  for (const [actor, loc] of [[U.locD, LOC.dallas], [opsA, LOC.austin]] as const) {
    const c = (await as<string>(actor, `SELECT authz.company_create($1, $2, NULL, NULL, NULL, NULL, NULL, NULL) AS id`, [loc, `Co ${loc}`]))[0]!.id!;
    const f = (await as<string>(actor, `SELECT authz.facility_create($1, $2, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL) AS id`,
      [loc, `GH ${loc}`]))[0]!.id!;
    const u = await utilityWithPassword(actor, "company", c, `secret-${loc}`);
    const b = (await as<string>(actor, `SELECT authz.bill_create('company', $1, $2, 'ach', 12.5, '2025-01-01', '2025-01-31', '2025-02-10', NULL) AS id`, [c, u]))[0]!.id!;
    await as(actor, `SELECT authz.incharge_add('company', $1, $2)`, [c, actor]);
    ids.company.push(c); ids.facility.push(f); ids.utility.push(u); ids.bill.push(b);
  }
}, 120_000);

afterAll(async () => {
  await db?.drop();
});

describe("RLS (app role): rows by the caller's location grants", () => {
  const tables = ["company", "facility", "utility", "utility_bill", "company_incharge"] as const;
  it.each(users)("%s sees exactly its locations' rows", async (key) => {
    for (const t of tables) {
      const rows = await as<string>(U[key], t === "company_incharge"
        ? `SELECT company_id::text AS id FROM eureka.company_incharge`
        : `SELECT id::text AS id FROM eureka.${t}`, [], false);
      const visible = rows.map((r) => r.id);
      const all = t === "company" || t === "company_incharge" ? ids.company : t === "facility" ? ids.facility : t === "utility" ? ids.utility : ids.bill;
      expect(visible.filter((v) => all.includes(v!)).sort(), `${key} ${t}`).toEqual(key === "locD" ? [all[0]] : []);
    }
  });

  it("the Austin admin sees Austin only", async () => {
    expect((await as<string>(opsA, `SELECT id::text AS id FROM eureka.company`, [], false)).map((r) => r.id)).toEqual([ids.company[1]]);
    expect((await as<string>(opsA, `SELECT id::text AS id FROM eureka.utility_bill`, [], false)).map((r) => r.id)).toEqual([ids.bill[1]]);
  });

  it("the scope arrays are InitPlans, not per-row function calls (rule 3)", async () => {
    const c = await db.admin.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT set_config('eureka.user_id', $1, true)", [U.locD]);
      await c.query("SET LOCAL ROLE eureka_app");
      for (const t of ["company", "facility", "utility", "utility_bill"]) {
        const plan = (await c.query<{ "QUERY PLAN": string }>(`EXPLAIN SELECT id FROM eureka.${t}`)).rows.map((r) => r["QUERY PLAN"]).join("\n");
        expect(plan, t).toMatch(/InitPlan/);
      }
    } finally {
      await c.query("ROLLBACK");
      c.release();
    }
  });

  it("the app role cannot read the password ciphertext, key or MAC", async () => {
    for (const col of ["password_enc", "password_mac", "password_key_id"]) {
      expect(await denied(() => as(U.locD, `SELECT ${col} FROM eureka.utility`, [], false))).toMatch(/permission denied/);
    }
    expect((await as<boolean>(U.locD, `SELECT has_password FROM eureka.utility`, [], false))[0]!.has_password).toBe(true);
  });
});

describe("writes: definer functions only, permission and location re-checked", () => {
  it("the app role has no direct write on any table", async () => {
    for (const sql of [
      `INSERT INTO eureka.company (location_id, name, created_by, updated_by) VALUES ('${LOC.dallas}', 'X', '${U.locD}', '${U.locD}')`,
      `UPDATE eureka.company SET name = 'X'`,
      `DELETE FROM eureka.company`,
      `UPDATE eureka.utility_bill SET amount = 1`,
      `DELETE FROM eureka.company_incharge`,
      `INSERT INTO eureka.company_employee (company_id, person_id, start_date, created_by) VALUES ('${ids.company[0]}', '${U.locD}', '2025-01-01', '${U.locD}')`,
    ]) {
      expect(await denied(() => as(U.locD, sql)), sql).toMatch(/permission denied/);
    }
  });

  it.each([
    ["r1a creates a company", U.r1a, `SELECT authz.company_create('${LOC.dallas}', 'Nope', NULL, NULL, NULL, NULL, NULL, NULL)`, /not_permitted/],
    ["locD creates in Austin", U.locD, `SELECT authz.company_create('${LOC.austin}', 'Nope', NULL, NULL, NULL, NULL, NULL, NULL)`, /not_permitted/],
    ["locD edits an Austin company", U.locD, () => `SELECT authz.company_update('${ids.company[1]}', 1, '${LOC.austin}', 'X', NULL, NULL, NULL, NULL, NULL, 'active', NULL)`, /not_found/],
    ["locD adds an incharge in Austin", U.locD, () => `SELECT authz.incharge_add('company', '${ids.company[1]}', '${U.locD}')`, /not_found/],
    ["locD adds an Austin bill", U.locD, () => `SELECT authz.bill_create('company', '${ids.company[1]}', '${ids.utility[1]}', 'ach', 1, '2025-01-01', '2025-01-02', '2025-01-03', NULL)`, /not_found/],
    ["locD bills a Dallas company on an Austin utility", U.locD, () => `SELECT authz.bill_create('company', '${ids.company[0]}', '${ids.utility[1]}', 'ach', 1, '2025-01-01', '2025-01-02', '2025-01-03', NULL)`, /invalid_utility/],
    ["locD voids an Austin bill", U.locD, () => `SELECT authz.bill_void('${ids.bill[1]}', 'x')`, /not_found/],
    ["locD reveals an Austin password", U.locD, () => `SELECT * FROM authz.utility_password_reveal('${ids.utility[1]}', '\\x00')`, /not_found/],
    ["locD reveals without a step-up", U.locD, () => `SELECT * FROM authz.utility_password_reveal('${ids.utility[0]}', '\\x00')`, /step_up_required/],
    ["hr reveals", U.hr, () => `SELECT * FROM authz.utility_password_reveal('${ids.utility[0]}', '\\x00')`, /not_found/],
    ["locD reads Austin employees", U.locD, () => `SELECT * FROM authz.company_employees('${ids.company[1]}')`, /not_found/],
    ["no user", "", `SELECT authz.company_create('${LOC.dallas}', 'Nope', NULL, NULL, NULL, NULL, NULL, NULL)`, /not_permitted|invalid input syntax/],
  ] as const)("%s → refused", async (_n, actor, sql, why) => {
    expect(await denied(() => as(actor, typeof sql === "function" ? sql() : sql))).toMatch(why);
  });

  it("server-managed columns: the guard sets them whatever the definer passes; only definer writes; nothing deleted or truncated", async () => {
    const c = await db.admin.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL ROLE authz_definer");
      // No user: refused.
      expect(await denied(() => c.query(`INSERT INTO eureka.company (location_id, name, created_by, updated_by) VALUES ($1, 'G', $2, $2)`, [LOC.dallas, U.hr])))
        .toMatch(/not_permitted/);
    } finally {
      await c.query("ROLLBACK");
    }
    try {
      await c.query("BEGIN");
      await c.query("SELECT set_config('eureka.user_id', $1, true)", [U.locD]);
      await c.query("SET LOCAL ROLE authz_definer");
      const r = (await c.query(`INSERT INTO eureka.company (location_id, name, status, row_version, created_by, updated_by, created_at)
                                VALUES ($1, 'Guarded', 'inactive', 99, $2, $2, '2001-01-01') RETURNING status, row_version, created_by, created_at`,
        [LOC.dallas, U.hr])).rows[0];
      expect(r.status).toBe("active");
      expect(r.row_version).toBe(1);
      expect(r.created_by).toBe(U.locD);
      expect(new Date(r.created_at).getFullYear()).toBeGreaterThan(2001);
      const b = (await c.query(`INSERT INTO eureka.utility_bill (utility_id, payment_method, amount, billing_start, billing_end, due_date,
                                  void_reason, voided_by, voided_at, created_by, updated_by)
                                VALUES ($1, 'ach', 5, '2025-01-01', '2025-01-02', '2025-01-03', 'x', $2, now(), $2, $2)
                                RETURNING voided_at, void_reason`, [ids.utility[0], U.hr])).rows[0];
      expect(b).toEqual({ voided_at: null, void_reason: null });
      await c.query("SAVEPOINT s");
      expect(await denied(() => c.query(`DELETE FROM eureka.company WHERE id = $1`, [ids.company[0]]))).toMatch(/permission denied|not deleted/);
      await c.query("ROLLBACK TO SAVEPOINT s");
      expect(await denied(() => c.query(`UPDATE eureka.company SET created_by = $2 WHERE id = $1`, [ids.company[0], U.hr]))).toMatch(/permission denied|immutable/);
    } finally {
      await c.query("ROLLBACK");
      c.release();
    }
    // Truncation is refused even for the owner.
    const o = await db.admin.connect();
    try {
      await o.query("BEGIN");
      await o.query("SET LOCAL ROLE eureka_owner");
      expect(await denied(() => o.query(`TRUNCATE eureka.utility_bill`))).toMatch(/not truncated|cannot truncate/);
    } finally {
      await o.query("ROLLBACK");
      o.release();
    }
  });

  it("a voided bill is final; an employee works for one company at a time", async () => {
    const b = (await as<string>(U.locD, `SELECT authz.bill_create('company', $1, $2, 'ach', 3, '2025-01-01', '2025-01-02', '2025-01-03', NULL) AS id`,
      [ids.company[0], ids.utility[0]]))[0]!.id!;
    await as(U.locD, `SELECT authz.bill_void($1, 'typo')`, [b]);
    expect(await denied(() => as(U.locD, `SELECT authz.bill_update($1, 2, $2, 'ach', 4, '2025-01-01', '2025-01-02', '2025-01-03', NULL)`, [b, ids.utility[0]])))
      .toMatch(/bill_voided/);
    expect(await denied(() => as(U.locD, `SELECT authz.bill_void($1, 'again')`, [b]))).toMatch(/bill_voided/);

    const e = await joinedEmployee(db);
    const c2 = (await as<string>(U.locD, `SELECT authz.company_create($1, 'Second Co', NULL, NULL, NULL, NULL, NULL, NULL) AS id`, [LOC.dallas]))[0]!.id!;
    await as(U.locD, `SELECT authz.company_employee_add($1, $2, '2025-01-01')`, [ids.company[0], e.personId]);
    expect(await denied(() => as(U.locD, `SELECT authz.company_employee_add($1, $2, '2025-02-01')`, [c2, e.personId]))).toMatch(/employee_assigned/);
    // The employee list (definer) shows names to company:read; eureka.employee itself stays org-scoped.
    expect((await as<string>(U.locD, `SELECT * FROM authz.company_employees($1)`, [ids.company[0]], false)).map((r) => r.person_id)).toEqual([e.personId]);
    expect(await as(U.locD, `SELECT person_id FROM eureka.employee`, [], false)).toEqual([]);
  });
});

describe("concurrency: the owner's location is locked while an incharge or employee is added", () => {
  it("an incharge_add racing a location move waits for it and is checked against the new location", async () => {
    const both = (await db.admin.query<{ id: string }>(
      `INSERT INTO eureka.app_user (email, display_name) VALUES ('opsDA@eureka.example', 'opsDA') RETURNING id`)).rows[0]!.id;
    for (const loc of [LOC.dallas, LOC.austin]) {
      await db.admin.query(`INSERT INTO eureka.user_role (user_id, role_key, location_id) VALUES ($1, 'location_ops_admin', $2)`, [both, loc]);
    }
    const co = (await as<string>(both, `SELECT authz.company_create($1, 'Moving Co', NULL, NULL, NULL, NULL, NULL, NULL) AS id`, [LOC.dallas]))[0]!.id!;
    const a = await db.app.connect();
    try {
      await a.query("BEGIN");
      await a.query("SELECT set_config('eureka.user_id', $1, true)", [both]);
      // A moves the company to Austin and holds the row lock until it commits.
      await a.query(`SELECT authz.company_update($1, 1, $2, 'Moving Co', NULL, NULL, NULL, NULL, NULL, 'active', NULL)`, [co, LOC.austin]);
      let settled = false;
      // B adds a Dallas-only user as incharge meanwhile.
      const b = as(both, `SELECT authz.incharge_add('company', $1, $2)`, [co, U.locD]).then(() => "added", (e: Error) => e.message)
        .finally(() => { settled = true; });
      await new Promise((r) => setTimeout(r, 300));
      expect(settled).toBe(false); // waiting on the owner row
      await a.query("COMMIT");
      expect(await b).toMatch(/invalid_incharge/);
    } finally {
      a.release();
    }
    expect((await db.admin.query(`SELECT location_id FROM eureka.company WHERE id = $1`, [co])).rows[0].location_id).toBe(LOC.austin);
    expect((await db.admin.query(`SELECT count(*)::int AS n FROM eureka.company_incharge WHERE company_id = $1`, [co])).rows[0].n).toBe(0);
  });
});

describe("EXECUTE grants (rule 2)", () => {
  const appFns = ["company_create", "company_update", "facility_create", "facility_update", "incharge_add", "incharge_remove",
    "company_employee_add", "company_employee_end", "company_employees", "company_employee_options", "utility_create", "utility_update",
    "utility_password_reveal", "bill_create", "bill_update", "bill_void", "bill_invoice_upload", "bill_invoice_download"];
  const internal = ["location_allows", "facilities_owner_location", "facilities_scope", "facilities_lock_owner", "facilities_scope_locked",
    "facilities_location_user",
    "facilities_target_location", "utility_check_password", "utility_owner", "bill_scope"];
  it("app functions: app only; helpers: nobody; no PUBLIC; pinned search_path; owned by authz_definer", async () => {
    const rows = (await db.admin.query<{ name: string; app: boolean; worker: boolean; pub: boolean; cfg: string[] | null; owner: string; definer: boolean }>(
      `SELECT p.proname AS name, has_function_privilege('eureka_app', p.oid, 'EXECUTE') AS app,
              has_function_privilege('eureka_worker', p.oid, 'EXECUTE') AS worker,
              coalesce(p.proacl::text ~ '(^|[{,])=X', p.proacl IS NULL) AS pub, p.proconfig AS cfg, pg_get_userbyid(p.proowner) AS owner,
              p.prosecdef AS definer
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'authz' AND p.proname = ANY ($1)`, [[...appFns, ...internal]])).rows;
    expect(rows.map((r) => r.name).sort()).toEqual([...appFns, ...internal].sort());
    for (const r of rows) {
      expect(r.pub, r.name).toBe(false);
      expect(r.cfg, r.name).toEqual(["search_path=pg_catalog, pg_temp"]);
      expect([r.owner, r.definer], r.name).toEqual(["authz_definer", true]);
      expect(r.app, r.name).toBe(appFns.includes(r.name));
      expect(r.worker, r.name).toBe(false);
    }
  });

  it("the worker keeps only the rotation functions it had", async () => {
    for (const f of ["field_rotation_batch(text,uuid,uuid,integer)", "field_rotation_apply(text,uuid,bytea,bytea,uuid)"]) {
      const r = (await db.admin.query(`SELECT has_function_privilege('eureka_worker', $1, 'EXECUTE') AS w, has_function_privilege('eureka_app', $1, 'EXECUTE') AS a`,
        [`authz.${f}`])).rows[0];
      expect(r, f).toEqual({ w: true, a: false });
    }
  });
});

describe("key rotation: utility_password", () => {
  it("the monthly job re-encrypts every password under the month's key; plaintext, MAC and row_version unchanged", async () => {
    const extra = await utilityWithPassword(U.locD, "facility", ids.facility[0]!, "third-secret");
    const none = await utilityWithPassword(U.locD, "facility", ids.facility[0]!, null);
    const before = (await db.admin.query(`SELECT id, password_mac, row_version, updated_at FROM eureka.utility ORDER BY id`)).rows;
    const job = keyRotationJob(workerCipher, { batchSize: 1 });
    expect(await new JobRunner(db.worker, [job], silentLogger).runOnce(job, thisMonth())).toBe("ran");
    const detail = (await db.admin.query(`SELECT detail FROM eureka.job_run WHERE job_name = $1 AND run_key = $2`, [KEY_ROTATION_JOB, thisMonth()])).rows[0].detail;
    expect(detail.utility_password).toEqual({ keyVersion: 2, reencrypted: 3, skipped: 0, failed: 0 });
    const key = (await db.admin.query(`SELECT id FROM eureka.field_key WHERE field_class = 'utility_password' AND rotation_key = $1`, [thisMonth()])).rows[0].id;
    const rows = (await db.admin.query(`SELECT id, password_enc, password_key_id FROM eureka.utility WHERE password_enc IS NOT NULL ORDER BY id`)).rows;
    expect(rows.every((r) => r.password_key_id === key)).toBe(true);
    // A cold API cipher decrypts every value to the same plaintext.
    const cold = new FieldCipher(new LocalKeyProvider());
    const plain = await asUser(db.app, U.locD, async (c) => Promise.all(rows.map((r) => cold.decrypt(c, { cls: "utility_password", rowId: r.id }, r.password_enc))));
    expect(plain.sort()).toEqual([`secret-${LOC.austin}`, `secret-${LOC.dallas}`, "third-secret"].sort());
    expect((await db.admin.query(`SELECT id, password_mac, row_version, updated_at FROM eureka.utility ORDER BY id`)).rows).toEqual(before);
    expect((await db.admin.query(`SELECT count(*)::int AS n FROM eureka.field_rotation_log WHERE field_class = 'utility_password'`)).rows[0].n).toBe(3);
    expect((await db.admin.query(`SELECT password_enc FROM eureka.utility WHERE id = $1`, [none])).rows[0].password_enc).toBeNull();
    // Idempotent within the month.
    expect((await job.run(thisMonth(), { pool: db.worker, log: silentLogger, signal: new AbortController().signal, heartbeat() {} })) as Record<string, unknown>)
      .toMatchObject({ utility_password: { keyVersion: 2, reencrypted: 0, skipped: 0, failed: 0 } });
    void extra;
  });

  it("rotation (no user) cannot change anything but the ciphertext", async () => {
    const c = await db.admin.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL ROLE authz_definer");
      expect(await denied(() => c.query(`UPDATE eureka.utility SET service_provider = 'Forged' WHERE id = $1`, [ids.utility[0]])))
        .toMatch(/only the ciphertext/);
    } finally {
      await c.query("ROLLBACK");
      c.release();
    }
  });
});

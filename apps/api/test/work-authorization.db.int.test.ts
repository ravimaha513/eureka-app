import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { candidateVisible, resolveScope, workAuthAccess } from "@eureka/shared";
import { FieldCipher, FieldCryptoError, parseHeader } from "../src/platform/crypto/field-crypto.js";
import { LocalKeyProvider } from "../src/platform/crypto/key-provider.js";
import { KEY_ROTATION_JOB, keyRotationJob } from "../src/worker/jobs/key-rotation.js";
import { VISA_EXPIRY_JOB, visaExpiryJob } from "../src/worker/jobs/visa-expiry.js";
import { DELIVERED_TYPES } from "../src/worker/jobs/outbox.js";
import { silentLogger } from "../src/worker/log.js";
import { JobRunner } from "../src/worker/runner.js";
import { KEY_ROTATION_SCHEDULE, VISA_EXPIRY_SCHEDULE, dueMaintenanceKeys, dueMonthlyKeys } from "../src/worker/schedule.js";
import { asUser, createTestDb, type TestDb } from "./db-harness.js";
import { LOC, T, U, seedFixtures, toUserAccess, type FixtureCandidate } from "./fixtures.js";
import { newCandidate } from "./placement-seed.js";

/**
 * Database checks for migration 0042 with the API removed (design B8): the
 * field encryption platform against real key rows, key rotation as the worker
 * runs it, RLS differential for work authorization, definer-only writes and
 * the visa-expiry notices (time travel by moving valid_to relative to the
 * database's New York day).
 */
let db: TestDb;
let candidates: FixtureCandidate[];
const users = Object.keys(U) as (keyof typeof U)[];
const CLS = "work_auth_number" as const;
/** The API process and the worker process each have their own cipher (and key cache). */
const apiCipher = new FieldCipher(new LocalKeyProvider());
const workerCipher = new FieldCipher(new LocalKeyProvider());
const ctx = () => ({ pool: db.worker, log: silentLogger, signal: new AbortController().signal, heartbeat() {} });
const thisMonth = () => new Date().toISOString().slice(0, 7);
const lastMonth = () => { const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - 1); return d.toISOString().slice(0, 7); };

beforeAll(async () => {
  db = await createTestDb();
  candidates = await seedFixtures(db.admin);
}, 120_000);

afterAll(async () => {
  await db?.drop();
});

async function denied(fn: () => Promise<unknown>): Promise<string> {
  try { await fn(); } catch (err) { return (err as Error).message; }
  return "allowed";
}

/** Superuser write with triggers off (test setup and time travel only). */
async function force(sql: string, params: unknown[] = []) {
  const c = await db.admin.connect();
  try {
    await c.query("BEGIN");
    await c.query("SET LOCAL session_replication_role = replica");
    await c.query(sql, params);
    await c.query("COMMIT");
  } catch (err) {
    await c.query("ROLLBACK");
    throw err;
  } finally {
    c.release();
  }
}

interface WaOpts { number?: string | null; type?: string; status?: string; validFrom?: string | null; validTo?: string | null }

/** A record created as `actor` the way the API does it: encrypt bound to the new id, then the definer function. */
const createWa = (actor: string, candidateId: string, o: WaOpts = {}) => asUser(db.app, actor, async (c) => {
  const id = randomUUID();
  const sealed = o.number ? await apiCipher.encrypt(c, { cls: CLS, rowId: id }, o.number) : null;
  await c.query(`SELECT authz.work_auth_create($1, $2, $3, $4, $5, $6, $7, $8)`,
    [id, candidateId, o.type ?? "h1b", sealed?.enc ?? null, sealed?.keyId ?? null, o.validFrom ?? null, o.validTo ?? null, o.status ?? "valid"]);
  return id;
}, true);

const encOf = async (id: string) => (await db.admin.query<{ number_enc: Buffer; number_key_id: string }>(
  `SELECT number_enc, number_key_id FROM eureka.work_authorization WHERE id = $1`, [id])).rows[0]!;

/** r1a's own active Dallas candidate (team t1). */
const own = () => candidates.find((c) => c.recruiterId === U.r1a && c.visibility === "team" && c.marketingStatus === "active")!;
const fresh = () => newCandidate(db, { teamId: T.t1, recruiterId: U.r1a, locationId: LOC.dallas });
/** The New York calendar day `n` days from the database's today. */
const nyDay = async (n: number) => (await db.admin.query<{ d: string }>(
  `SELECT ((now() AT TIME ZONE 'America/New_York')::date + $1::int)::text AS d`, [n])).rows[0]!.d;

describe("first data key of a class", () => {
  it("first use of a class creates exactly one data key, wrapped; concurrent first uses agree", async () => {
    const cand = await fresh();
    const before = (await db.admin.query(`SELECT count(*)::int AS n FROM eureka.field_key WHERE field_class = $1`, [CLS])).rows[0].n;
    const [a, b] = await Promise.all([
      createWa(U.imm, cand.id, { number: "A-1" }), createWa(U.imm, cand.id, { number: "B-2" }),
    ]);
    const keys = (await db.admin.query(`SELECT id, version, provider, key_ref, wrapped_key, rotation_key FROM eureka.field_key WHERE field_class = $1`, [CLS])).rows;
    expect([before, keys.length]).toEqual([0, 1]);
    expect(keys[0]).toMatchObject({ provider: "local", key_ref: new LocalKeyProvider().keyRef });
    expect((await encOf(a)).number_key_id).toBe((await encOf(b)).number_key_id);
  });
});

describe("RLS differential: work authorization rows readable = engine", () => {
  const ids: string[] = [];
  beforeAll(async () => {
    for (const cand of candidates) {
      const id = randomUUID();
      ids.push(id);
      await force(`INSERT INTO eureka.work_authorization (id, person_id, auth_type, status, created_by, updated_by)
                   SELECT $1, person_id, 'h1b', 'valid', $2, $2 FROM eureka.candidate WHERE id = $3`, [id, U.imm, cand.id]);
    }
  });
  afterAll(async () => {
    await force(`DELETE FROM eureka.work_authorization WHERE id = ANY ($1::uuid[])`, [ids]);
  });

  it.each(users)("%s", async (key) => {
    const access = toUserAccess(key);
    const expected = candidates.filter((c) => workAuthAccess(access, c).read).map((c) => c.id).sort();
    const actual = await asUser(db.app, access.userId, async (c) => (await c.query<{ id: string }>(
      `SELECT c.id FROM eureka.work_authorization w JOIN eureka.candidate c ON c.person_id = w.person_id
        WHERE w.id = ANY ($1::uuid[])`, [ids])).rows.map((r) => r.id).sort());
    expect(actual).toEqual(expected);
    // Conservative rule: only visa:read holders (HR, Immigration) see any record.
    if (!["hr", "imm"].includes(key)) expect(actual).toEqual([]);
    else expect(actual.length).toBe(candidates.filter((c) => candidateVisible(resolveScope(access, "candidate:read"), c)).length);
  });

  it("the worker and a session without a user see nothing", async () => {
    expect(await denied(() => db.worker.query(`SELECT 1 FROM eureka.work_authorization`))).toMatch(/permission denied/);
    expect((await db.app.query(`SELECT count(*)::int AS n FROM eureka.work_authorization`)).rows[0].n).toBe(0);
  });
});

describe("writes only through definer functions, with permission and scope re-checked", () => {
  it("create: Immigration may; HR (visa:read only) 403; Sales and others 404; no user refused", async () => {
    const cand = own();
    const id = await createWa(U.imm, cand.id, { number: "EAC2190012345", validTo: "2027-06-30" });
    const row = (await db.admin.query(`SELECT * FROM eureka.work_authorization WHERE id = $1`, [id])).rows[0];
    expect(row).toMatchObject({ auth_type: "h1b", status: "valid", row_version: 1, created_by: U.imm, updated_by: U.imm });
    expect(await denied(() => createWa(U.hr, cand.id))).toBe("not_permitted");
    for (const u of [U.r1a, U.l1, U.m1, U.ceo, U.acct, U.locD, U.admin]) expect(await denied(() => createWa(u, cand.id)), u).toBe("not_found");
    expect(await denied(() => db.app.query(`SELECT authz.work_auth_create($1, $2, 'h1b', NULL, NULL, NULL, NULL, 'valid')`, [randomUUID(), cand.id])))
      .toBe("not_permitted");
  });

  it("the app and the worker cannot write the tables directly; nobody deletes or truncates", async () => {
    const cand = own();
    const id = await createWa(U.imm, cand.id);
    for (const sql of [
      `INSERT INTO eureka.work_authorization (id, person_id, auth_type, status, created_by, updated_by) VALUES (gen_random_uuid(), '${randomUUID()}', 'h1b', 'valid', '${U.imm}', '${U.imm}')`,
      `UPDATE eureka.work_authorization SET status = 'revoked' WHERE id = '${id}'`,
      `DELETE FROM eureka.work_authorization WHERE id = '${id}'`,
      `INSERT INTO eureka.field_key (id, field_class, version, provider, key_ref, wrapped_key) VALUES (gen_random_uuid(), 'dob', 9, 'local', 'x', '\\x00000000000000000000000000000000')`,
      `INSERT INTO eureka.outbox_event (type, aggregate_type, aggregate_id, payload) VALUES ('work_authorization.expiring', 'work_authorization', '${id}', '{}')`,
    ]) {
      expect(await denied(() => asUser(db.app, U.imm, (c) => c.query(sql))), sql).toMatch(/permission denied|violates row-level security/);
    }
    expect(await denied(() => db.worker.query(`SELECT * FROM eureka.work_authorization_notice`))).toMatch(/permission denied/);
    // Owner/superuser: the guards refuse deletes, truncation and key changes.
    expect(await denied(() => db.admin.query(`DELETE FROM eureka.work_authorization WHERE id = $1`, [id]))).toMatch(/not deleted|written only/);
    expect(await denied(() => db.admin.query(`TRUNCATE eureka.work_authorization CASCADE`))).toMatch(/not truncated/);
    expect(await denied(() => db.admin.query(`UPDATE eureka.field_key SET wrapped_key = wrapped_key`))).toMatch(/only added/);
    expect(await denied(() => db.admin.query(`DELETE FROM eureka.field_key`))).toMatch(/only added/);
  });

  it("server-managed columns: the trigger sets created/updated by and at, row_version; immutable columns refused", async () => {
    const cand = own();
    const id = await createWa(U.imm, cand.id, { validFrom: "2026-01-01", validTo: "2026-12-31" });
    const v = await asUser(db.app, U.imm, async (c) => (await c.query<{ v: number }>(
      `SELECT authz.work_auth_update($1, $2, 1, 'h1b', false, NULL, NULL, '2026-01-01', '2029-12-31', 'valid') AS v`, [id, cand.id])).rows[0]!.v, true);
    expect(v).toBe(2);
    // Stale row_version, wrong candidate, HR, Sales.
    const upd = (actor: string, candidateId: string, version: number) => asUser(db.app, actor, (c) => c.query(
      `SELECT authz.work_auth_update($1, $2, $3, 'h1b', false, NULL, NULL, NULL, NULL, 'revoked')`, [id, candidateId, version]));
    expect(await denied(() => upd(U.imm, cand.id, 1))).toBe("stale");
    expect(await denied(() => upd(U.imm, candidates[5]!.id, 2))).toBe("not_found");
    expect(await denied(() => upd(U.hr, cand.id, 2))).toBe("not_permitted");
    expect(await denied(() => upd(U.r1a, cand.id, 2))).toBe("not_found");
    // Dates out of order and unknown values hit the table CHECKs.
    expect(await denied(() => asUser(db.app, U.imm, (c) => c.query(
      `SELECT authz.work_auth_update($1, $2, 2, 'h1b', false, NULL, NULL, '2027-01-01', '2026-01-01', 'valid')`, [id, cand.id])))).toMatch(/work_authorization_dates/);
    expect(await denied(() => createWa(U.imm, cand.id, { type: "citizen" }))).toMatch(/auth_type_check/);
    // A forged ciphertext (not naming its key) or a key of another class is refused.
    expect(await denied(() => asUser(db.app, U.imm, (c) => c.query(
      `SELECT authz.work_auth_create($1, $2, 'h1b', $3, NULL, NULL, NULL, 'valid')`, [randomUUID(), cand.id, Buffer.alloc(60, 1)])))).toBe("invalid_number");
    expect(await denied(() => asUser(db.app, U.imm, (c) => c.query(
      `SELECT authz.work_auth_create($1, $2, 'h1b', $3, $4, NULL, NULL, 'valid')`, [randomUUID(), cand.id, Buffer.alloc(60, 1), randomUUID()])))).toBe("invalid_number");
    const r = (await db.admin.query(`SELECT * FROM eureka.work_authorization WHERE id = $1`, [id])).rows[0];
    expect(r).toMatchObject({ row_version: 2, created_by: U.imm, updated_by: U.imm, valid_to: expect.any(Date) });
    expect(await denied(() => force(`UPDATE eureka.work_authorization SET number_enc = $2, number_key_id = (SELECT id FROM eureka.field_key LIMIT 1) WHERE id = $1`,
      [id, Buffer.concat([Buffer.from([1]), Buffer.alloc(59, 7)])]))).toMatch(/number_format/);
  });
});

describe("field encryption against the database (design A6.3)", () => {
  it("round-trips through the table; the stored bytes do not contain the number", async () => {
    const cand = await fresh();
    const id = await createWa(U.imm, cand.id, { number: "IOE0912345678" });
    const { number_enc, number_key_id } = await encOf(id);
    expect(number_enc.includes(Buffer.from("IOE0912345678"))).toBe(false);
    expect(parseHeader(number_enc).keyId).toBe(number_key_id);
    const fresh2 = new FieldCipher(new LocalKeyProvider()); // cold cache: unwraps from field_key
    expect(await asUser(db.app, U.imm, (c) => fresh2.decrypt(c, { cls: CLS, rowId: id }, number_enc))).toBe("IOE0912345678");
  });

  it("a ciphertext copied to another row does not decrypt there (encryption context = table, column, row id)", async () => {
    const cand = await fresh();
    const a = await createWa(U.imm, cand.id, { number: "COPY-ME-1" });
    const b = await createWa(U.imm, cand.id, { number: "OTHER-2" });
    const { number_enc, number_key_id } = await encOf(a);
    const original = await encOf(b);
    await force(`UPDATE eureka.work_authorization SET number_enc = $2, number_key_id = $3 WHERE id = $1`, [b, number_enc, number_key_id]);
    await expect(asUser(db.app, U.imm, async (c) => apiCipher.decrypt(c, { cls: CLS, rowId: b }, (await encOf(b)).number_enc)))
      .rejects.toThrow(FieldCryptoError);
    await expect(asUser(db.app, U.imm, async (c) => apiCipher.decrypt(c, { cls: "dob", rowId: a }, number_enc))).rejects.toThrow(FieldCryptoError);
    await force(`UPDATE eureka.work_authorization SET number_enc = $2, number_key_id = $3 WHERE id = $1`, [b, original.number_enc, original.number_key_id]);
  });

  it("a data key of another provider or local key is refused, not misused", async () => {
    const cand = await fresh();
    const id = await createWa(U.imm, cand.id, { number: "PROVIDER-1" });
    const other = new FieldCipher(new LocalKeyProvider("ab".repeat(32)));
    await expect(asUser(db.app, U.imm, async (c) => other.decrypt(c, { cls: CLS, rowId: id }, (await encOf(id)).number_enc)))
      .rejects.toThrow(/another key provider/);
  });

  it("the API may only create a class's first key; rotation keys are the worker's, never in the future", async () => {
    const wrapped = Buffer.alloc(60, 3);
    expect(await denied(() => db.worker.query(`SELECT authz.field_key_first($1, 'dob', 'local', 'x', $2)`, [randomUUID(), wrapped]))).toMatch(/permission denied/);
    expect(await denied(() => asUser(db.app, U.imm, (c) => c.query(`SELECT authz.field_key_rotate($1, 'dob', 'local', 'x', $2, '2026-01')`, [randomUUID(), wrapped]))))
      .toMatch(/permission denied/);
    expect(await denied(() => db.worker.query(`SELECT authz.field_key_rotate($1, 'dob', 'local', 'x', $2, '2999-01')`, [randomUUID(), wrapped]))).toMatch(/future/);
    expect(await denied(() => db.worker.query(`SELECT authz.field_key_rotate($1, 'dob', 'local', 'x', $2, '2026-13')`, [randomUUID(), wrapped]))).toBe("invalid_key");
    // A second "first" key is not added: the existing one is returned.
    const k1 = (await asUser(db.app, U.imm, (c) => c.query(`SELECT * FROM authz.field_key_first($1, $2, 'local', 'x', $3)`, [randomUUID(), CLS, wrapped]))).rows[0];
    expect(k1.id).toBe((await db.admin.query(`SELECT id FROM eureka.field_key WHERE field_class = $1 ORDER BY version DESC LIMIT 1`, [CLS])).rows[0].id);
  });
});

describe("key-rotation job (worker)", () => {
  it("re-encrypts every row under the month's new key version; plaintext unchanged; idempotent; leased", async () => {
    const cand = await fresh();
    const numbers = ["ROT-1", "ROT-2", "ROT-3", "ROT-4", "ROT-5"];
    const ids = [];
    for (const n of numbers) ids.push(await createWa(U.imm, cand.id, { number: n }));
    const noNumber = await createWa(U.imm, cand.id, {});
    const versionOf = async (id: string) => (await db.admin.query<{ version: number }>(
      `SELECT k.version FROM eureka.work_authorization w JOIN eureka.field_key k ON k.id = w.number_key_id WHERE w.id = $1`, [id])).rows[0]!.version;
    const before = await versionOf(ids[0]!);
    const total = (await db.admin.query(`SELECT count(*)::int AS n FROM eureka.work_authorization WHERE number_enc IS NOT NULL`)).rows[0].n;

    // Time travel: last month's run (it was missed), then this month's.
    const job = keyRotationJob(workerCipher, { batchSize: 2 });
    const runner = new JobRunner(db.worker, [job], silentLogger);
    expect(await runner.runOnce(job, lastMonth())).toBe("ran");
    for (const id of ids) expect(await versionOf(id)).toBe(before + 1);
    const detail = (await db.admin.query(`SELECT detail FROM eureka.job_run WHERE job_name = $1 AND run_key = $2`, [KEY_ROTATION_JOB, lastMonth()])).rows[0].detail;
    expect(detail).toEqual({ work_auth_number: { keyVersion: before + 1, reencrypted: total, skipped: 0, failed: 0 } });
    expect(JSON.stringify(detail)).not.toMatch(/ROT-/);

    expect(await runner.runOnce(job, thisMonth())).toBe("ran");
    for (const id of ids) expect(await versionOf(id)).toBe(before + 2);
    // Values decrypt to the same plaintext, bound to their rows, with a cold API cache.
    const cold = new FieldCipher(new LocalKeyProvider());
    for (const [i, id] of ids.entries()) {
      expect(await asUser(db.app, U.imm, async (c) => cold.decrypt(c, { cls: CLS, rowId: id }, (await encOf(id)).number_enc))).toBe(numbers[i]);
    }
    expect((await encOf(noNumber)).number_enc).toBeNull();
    // Rotation is not a user edit: row_version and updated_* unchanged.
    expect((await db.admin.query(`SELECT DISTINCT row_version FROM eureka.work_authorization WHERE id = ANY ($1::uuid[])`, [ids])).rows).toEqual([{ row_version: 1 }]);

    // Idempotent: the same month again is done (runner) and finds nothing (job), one key per month.
    expect(await runner.runOnce(job, thisMonth())).toBe("done-before");
    expect(await job.run(thisMonth(), ctx())).toEqual({ work_auth_number: { keyVersion: before + 2, reencrypted: 0, skipped: 0, failed: 0 } });
    expect((await db.admin.query(`SELECT count(*)::int AS n FROM eureka.field_key WHERE field_class = $1 AND rotation_key = $2`, [CLS, thisMonth()])).rows[0].n).toBe(1);
    // An older month's run cannot rotate backwards once a newer key exists.
    await expect(job.run(lastMonth(), ctx())).rejects.toThrow(/not_current_key/);

    // Lease: another runner holding a live lease on next month's key is not disturbed.
    await force(`INSERT INTO eureka.job_run (job_name, run_key, status, lease_until) VALUES ($1, '2099-01', 'running', now() + interval '10 minutes')`, [KEY_ROTATION_JOB]);
    expect(await runner.runOnce(job, "2099-01")).toBe("leased");
  });

  it("new API writes after a rotation use the newest key; a concurrent write wins over the rotation's swap", async () => {
    const cand = await fresh();
    const id = await createWa(U.imm, cand.id, { number: "RACE-1" });
    const newest = (await db.admin.query(`SELECT id, version FROM eureka.field_key WHERE field_class = $1 ORDER BY version DESC LIMIT 1`, [CLS])).rows[0];
    expect((await encOf(id)).number_key_id).toBe(newest.id);
    // The worker read an old ciphertext; the row changed meanwhile: apply refuses (compare-and-swap).
    const old = (await encOf(id)).number_enc;
    expect((await db.worker.query(`SELECT authz.field_rotation_apply($1, $2, $3, $4, $5) AS ok`,
      [CLS, id, Buffer.concat([old.subarray(0, 40), Buffer.alloc(old.length - 40, 0)]), old, newest.id])).rows[0].ok).toBe(false);
    // Only to the newest key, never sideways or backwards.
    const older = (await db.admin.query(`SELECT id FROM eureka.field_key WHERE field_class = $1 AND version < $2 ORDER BY version LIMIT 1`, [CLS, newest.version])).rows[0];
    expect(await denied(() => db.worker.query(`SELECT authz.field_rotation_apply($1, $2, $3, $4, $5)`, [CLS, id, old, old, older.id]))).toBe("not_current_key");
    expect(await denied(() => db.worker.query(`SELECT * FROM authz.field_rotation_batch($1, $2, NULL, 10)`, [CLS, older.id]))).toBe("not_current_key");
    expect(await denied(() => db.worker.query(`SELECT * FROM authz.field_rotation_batch('dob', $1, NULL, 10)`, [newest.id]))).toBe("unsupported field class");
    expect((await db.worker.query(`SELECT authz.field_rotation_apply($1, $2, $3, $3, $4) AS ok`, [CLS, id, old, newest.id])).rows[0].ok).toBe(false);
  });

  it("a row that does not decrypt is counted and left unchanged; the rest are rotated", async () => {
    const cand = await fresh();
    const good = await createWa(U.imm, cand.id, { number: "GOOD-1" });
    const bad = await createWa(U.imm, cand.id, { number: "BAD-1" });
    const { number_enc, number_key_id } = await encOf(good);
    await force(`UPDATE eureka.work_authorization SET number_enc = $2, number_key_id = $3 WHERE id = $1`, [bad, number_enc, number_key_id]);
    // Time travel: this month's rotation already ran; pretend its key came from an earlier run so this month rotates again.
    await force(`UPDATE eureka.field_key SET rotation_key = NULL WHERE field_class = $1 AND rotation_key = $2`, [CLS, thisMonth()]);
    const out = await keyRotationJob(workerCipher, { batchSize: 10 }).run(thisMonth(), ctx()) as Record<string, { failed: number; reencrypted: number }>;
    expect(out.work_auth_number!.failed).toBe(1);
    expect(out.work_auth_number!.reencrypted).toBeGreaterThan(0);
    expect((await encOf(bad)).number_enc.equals(number_enc)).toBe(true);
    expect(await asUser(db.app, U.imm, async (c) => apiCipher.decrypt(c, { cls: CLS, rowId: good }, (await encOf(good)).number_enc))).toBe("GOOD-1");
  });

  it("is scheduled monthly on the 1st after 05:00 New York time", () => {
    expect(dueMonthlyKeys(new Date("2026-11-01T08:59:00Z"), KEY_ROTATION_SCHEDULE)).toEqual([]); // 03:59 EST (DST ended at 02:00)
    expect(dueMonthlyKeys(new Date("2026-11-01T10:00:00Z"), KEY_ROTATION_SCHEDULE)).toEqual(["2026-11"]);
    expect(dueMonthlyKeys(new Date("2026-10-31T23:00:00Z"), KEY_ROTATION_SCHEDULE)).toEqual(["2026-10"]);
  });
});

describe("visa-expiry notices (time travel on valid_to)", () => {
  const events = async (waId: string) => (await db.admin.query<{ type: string; aggregate_type: string; payload: Record<string, unknown> }>(
    `SELECT type, aggregate_type, payload FROM eureka.outbox_event WHERE aggregate_id = $1 ORDER BY created_at, (payload->>'threshold_days')::int DESC`, [waId])).rows;
  const runJob = () => visaExpiryJob([90, 60, 30]).run("label", ctx());
  const moveTo = async (id: string, days: number) => force(`UPDATE eureka.work_authorization SET valid_to = $2 WHERE id = $1`, [id, await nyDay(days)]);

  it("90/60/30: one event per threshold as the expiry approaches; reruns add nothing", async () => {
    const cand = await fresh();
    const id = await createWa(U.imm, cand.id, { number: "EXP-1", validTo: await nyDay(120) });
    await runJob();
    expect(await events(id)).toEqual([]);
    await moveTo(id, 90);
    await runJob();
    await runJob();
    expect((await events(id)).map((e) => e.payload.threshold_days)).toEqual([90]);
    await moveTo(id, 61);
    await runJob();
    expect((await events(id)).length).toBe(1);
    await moveTo(id, 59); // a missed day: 60 is caught up at 59
    await runJob();
    await moveTo(id, 30);
    await runJob();
    await moveTo(id, 0);
    await runJob();
    await moveTo(id, -1);
    await runJob();
    expect((await events(id)).map((e) => [e.payload.threshold_days, e.payload.days_left])).toEqual([[90, 90], [60, 59], [30, 30]]);
  });

  it("the event carries ids, dates and days only (no number, no type), for HR and Immigration; the notification delivery handles it", async () => {
    const cand = await fresh();
    const id = await createWa(U.imm, cand.id, { number: "SECRET-NUM-9", type: "h4_ead", validTo: await nyDay(45) });
    expect(await visaExpiryJob([90, 60, 30]).run("label", ctx())).toMatchObject({ events: expect.any(Number) });
    const [ev] = await events(id);
    const person = (await db.admin.query(`SELECT person_id FROM eureka.candidate WHERE id = $1`, [cand.id])).rows[0].person_id;
    expect(ev).toEqual({ type: "work_authorization.expiring", aggregate_type: "work_authorization", payload: {
      candidate_id: cand.id, person_id: person, expires_on: await nyDay(45), threshold_days: 60, days_left: 45, notify: ["hr", "immigration"],
    } });
    expect(JSON.stringify(ev)).not.toMatch(/SECRET|h4_ead/);
    expect((DELIVERED_TYPES as readonly string[]).includes("work_authorization.expiring")).toBe(true);
  });

  it("entered late: only the smallest threshold reached; pending, revoked and undated records get none; renewal restarts", async () => {
    const cand = await fresh();
    const late = await createWa(U.imm, cand.id, { validTo: await nyDay(20) });
    const pending = await createWa(U.imm, cand.id, { status: "pending", validTo: await nyDay(20) });
    const revoked = await createWa(U.imm, cand.id, { status: "revoked", validTo: await nyDay(20) });
    const undated = await createWa(U.imm, cand.id, { validTo: null });
    await runJob();
    expect((await events(late)).map((e) => e.payload.threshold_days)).toEqual([30]);
    for (const id of [pending, revoked, undated]) expect(await events(id)).toEqual([]);
    // Renewed by Immigration: a new expiry date starts a new cycle.
    await asUser(db.app, U.imm, async (c) => c.query(
      `SELECT authz.work_auth_update($1, $2, 1, 'h1b', false, NULL, NULL, NULL, $3, 'valid')`, [late, cand.id, await nyDay(85)]), true);
    await runJob();
    expect((await events(late)).map((e) => e.payload.threshold_days)).toEqual([30, 90]);
  });

  it("thresholds are validated in the database; only the worker may run it", async () => {
    for (const bad of [[], [0], [400], [30, null], Array.from({ length: 11 }, (_, i) => i + 1)]) {
      expect(await denied(() => db.worker.query(`SELECT authz.work_auth_expiry_notices($1::int[])`, [bad]))).toMatch(/invalid thresholds/);
    }
    expect(await denied(() => asUser(db.app, U.imm, (c) => c.query(`SELECT authz.work_auth_expiry_notices('{30}')`)))).toMatch(/permission denied/);
  });

  it("runs daily after 06:00 New York time through the lease runner", async () => {
    expect(dueMaintenanceKeys(new Date("2026-10-01T09:59:00Z"), VISA_EXPIRY_SCHEDULE)).toEqual([]);
    expect(dueMaintenanceKeys(new Date("2026-10-01T10:00:00Z"), VISA_EXPIRY_SCHEDULE)).toEqual(["2026-09-30"]);
    const job = visaExpiryJob([90, 60, 30]);
    const runner = new JobRunner(db.worker, [job], silentLogger);
    const key = (await db.admin.query(`SELECT (current_date - 1)::text AS d`)).rows[0].d;
    expect(await runner.runOnce(job, key)).toBe("ran");
    expect(await runner.runOnce(job, key)).toBe("done-before");
    expect((await db.admin.query(`SELECT status FROM eureka.job_run WHERE job_name = $1 AND run_key = $2`, [VISA_EXPIRY_JOB, key])).rows[0].status).toBe("succeeded");
  });
});

describe("DOB columns (OD-04 open: format only)", () => {
  it("person.dob_enc must be an envelope ciphertext and dob_bidx a 32-byte MAC, set together", async () => {
    const p = (await db.admin.query(`SELECT person_id FROM eureka.candidate LIMIT 1`)).rows[0].person_id as string;
    const set = (enc: Buffer | null, bidx: Buffer | null) => db.admin.query(`UPDATE eureka.person SET dob_enc = $2, dob_bidx = $3 WHERE id = $1`, [p, enc, bidx]);
    expect(await denied(() => set(Buffer.from("1990-01-31"), null))).toMatch(/person_dob_enc_format/);
    expect(await denied(() => set(Buffer.concat([Buffer.from([1]), Buffer.alloc(60)]), Buffer.alloc(16)))).toMatch(/person_dob_bidx_format/);
    expect(await denied(() => set(null, Buffer.alloc(32)))).toMatch(/person_dob_bidx_needs_value/);
    expect(await denied(() => set(Buffer.concat([Buffer.from([1]), Buffer.alloc(60)]), Buffer.alloc(32)))).toBe("allowed");
    await set(null, null);
  });
});


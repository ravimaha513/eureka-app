import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AuditService } from "../src/platform/audit.service.js";
import { loadWorkerConfig } from "../src/worker/config.js";
import { auditExportJob, auditObjectKey, exportAuditDay } from "../src/worker/jobs/audit-export.js";
import { silentLogger } from "../src/worker/log.js";
import { JobRunner, type JobDefinition } from "../src/worker/runner.js";
import { dailyDueAt, dueDailyKeys } from "../src/worker/schedule.js";
import { DirSink, S3Sink } from "../src/worker/sink.js";
import { createTestDb, type TestDb } from "./db-harness.js";
import { U, seedFixtures } from "./fixtures.js";

let db: TestDb;
let exportDir: string;
const extraPools: pg.Pool[] = [];
const DAY = "2026-03-10";          // exported day
const NEXT = "2026-03-11";         // must not leak into DAY's file
const PHONES: string[] = [];

function workerPool(): pg.Pool {
  const u = new URL(process.env.TEST_PG_ADMIN_URL ?? "postgres://postgres:postgres@127.0.0.1:5432");
  const p = new pg.Pool({ connectionString: `postgres://eureka_worker:eureka_app_test@${u.host}/${db.name}`, max: 3 });
  extraPools.push(p);
  return p;
}

/** Writes audit rows through AuditService as the app role, then backdates them (superuser). */
async function audit(at: string, action: string, changes: Record<string, unknown>): Promise<void> {
  const c = await db.app.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('eureka.user_id', $1, true)", [U.r1a]);
    await new AuditService().record(c, { actorId: U.r1a, action, entityType: "candidate", changes });
    await c.query("COMMIT");
  } finally {
    c.release();
  }
  await db.admin.query(
    "UPDATE eureka.audit_event SET at = $1, ip = '10.0.0.7' WHERE seq = (SELECT max(seq) FROM eureka.audit_event)", [at]);
}

beforeAll(async () => {
  db = await createTestDb();
  await seedFixtures(db.admin);
  const { rows } = await db.admin.query<{ phone_e164: string }>("SELECT phone_e164 FROM eureka.person LIMIT 3");
  PHONES.push(...rows.map((r) => r.phone_e164));
  await audit(`${DAY}T00:00:00Z`, "candidate.updated", { phone_e164: PHONES[0], marketing_status: "active" });
  await audit(`${DAY}T12:34:56.789Z`, "candidate.updated", { phone: PHONES[1], rate: 90, note: "hi" });
  await audit(`${DAY}T23:59:59.999Z`, "dob.revealed", { dob: "1990-01-01" });
  await audit(`${NEXT}T00:00:00Z`, "candidate.updated", { phone_e164: PHONES[2] });
  await audit("2026-03-09T23:59:59Z", "candidate.created", {});
  exportDir = await mkdtemp(join(tmpdir(), "eureka-audit-"));
}, 90_000);

afterAll(async () => {
  for (const p of extraPools) await p.end();
  await db?.drop();
  if (exportDir) await rm(exportDir, { recursive: true, force: true });
});

describe("audit export", () => {
  it("exports exactly the rows of one UTC day as gzip JSONL with a matching digest and ledger row", async () => {
    const sink = new DirSink(exportDir);
    const r = await exportAuditDay(db.worker, sink, DAY);
    expect(r).toMatchObject({ exportDate: DAY, rowCount: 3, skipped: false, objectKey: "audit/2026/03/10/audit-events.jsonl.gz" });

    const file = await readFile(join(exportDir, r.objectKey));
    expect(createHash("sha256").update(file).digest("hex")).toBe(r.sha256Hex);
    expect(file.length).toBe(r.byteSize);

    const text = gunzipSync(file).toString("utf8");
    expect(text.endsWith("\n")).toBe(true);
    const lines = text.trimEnd().split("\n").map((l) => JSON.parse(l));
    expect(lines.map((l) => l.at)).toEqual([
      "2026-03-10T00:00:00.000000Z", "2026-03-10T12:34:56.789000Z", "2026-03-10T23:59:59.999000Z"]);
    expect(lines.map((l) => l.action)).toEqual(["candidate.updated", "candidate.updated", "dob.revealed"]);
    const seqs = lines.map((l) => l.seq as number);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(lines[0]).toMatchObject({ actor_id: U.r1a, entity_type: "candidate", ip: "10.0.0.7",
      changes: { phone_e164: "[redacted]", marketing_status: "active" } });
    expect(lines[1].changes).toEqual({ phone: "[redacted]", rate: "[redacted]", note: "hi" });
    expect(lines[2].changes).toEqual({ dob: "[redacted]" });
    expect(Object.keys(lines[0]).sort()).toEqual(
      ["action", "actor_id", "at", "changes", "entity_id", "entity_type", "ip", "request_id", "seq"]);

    // No raw phone numbers from the fixtures (with or without +1) in the file.
    for (const p of PHONES) {
      expect(text).not.toContain(p);
      expect(text).not.toContain(p.slice(2));
    }

    const ledger = await db.admin.query("SELECT * FROM eureka.audit_export WHERE export_date = $1", [DAY]);
    expect(ledger.rows).toHaveLength(1);
    expect(ledger.rows[0]).toMatchObject({
      object_key: r.objectKey, row_count: 3, sha256_hex: r.sha256Hex,
      first_seq: String(seqs[0]), last_seq: String(seqs[2]), byte_size: String(file.length),
    });
  });

  it("re-running an exported day is a no-op (file untouched, one ledger row)", async () => {
    const path = join(exportDir, auditObjectKey(DAY));
    const before = await stat(path);
    const r = await exportAuditDay(db.worker, new DirSink(exportDir), DAY);
    expect(r.skipped).toBe(true);
    expect((await stat(path)).mtimeMs).toBe(before.mtimeMs);
    const n = await db.admin.query("SELECT count(*)::int AS n FROM eureka.audit_export WHERE export_date = $1", [DAY]);
    expect(n.rows[0].n).toBe(1);
  });

  it("exports an empty day as an empty (but signed) file", async () => {
    const r = await exportAuditDay(db.worker, new DirSink(exportDir), "2026-03-01");
    expect(r.rowCount).toBe(0);
    const file = await readFile(join(exportDir, r.objectKey));
    expect(gunzipSync(file).length).toBe(0);
    const row = await db.admin.query("SELECT first_seq, last_seq FROM eureka.audit_export WHERE export_date = '2026-03-01'");
    expect(row.rows[0]).toEqual({ first_seq: null, last_seq: null });
  });

  it("uploads to S3 with the SHA-256 checksum and leaves encryption to the bucket default", async () => {
    const sent: Record<string, unknown>[] = [];
    const s3 = { send: async (cmd: { input: Record<string, unknown> }) => { sent.push(cmd.input); return {}; } };
    const sink = new S3Sink(s3 as never, "eureka-prod-audit-123");
    const r = await exportAuditDay(db.worker, sink, "2026-03-09");
    expect(r.rowCount).toBe(1);
    expect(sent).toHaveLength(1);
    const input = sent[0]!;
    expect(input.Bucket).toBe("eureka-prod-audit-123");
    expect(input.Key).toBe("audit/2026/03/09/audit-events.jsonl.gz");
    expect(input.ChecksumSHA256).toBe(Buffer.from(r.sha256Hex, "hex").toString("base64"));
    expect(createHash("sha256").update(input.Body as Buffer).digest("hex")).toBe(r.sha256Hex);
    expect(input).not.toHaveProperty("ServerSideEncryption");
    expect(input).not.toHaveProperty("SSEKMSKeyId");
  });

  it("concurrent runners (two worker tasks) export a day exactly once", async () => {
    const day = "2026-03-11";
    let puts = 0;
    const dir = new DirSink(exportDir);
    const counting = { kind: "dir" as const, put: async (...a: Parameters<DirSink["put"]>) => { puts++; await dir.put(...a); } };
    const job = auditExportJob(counting, 3);
    const runners = [0, 1, 2].map(() => new JobRunner(workerPool(), [job], silentLogger));
    const outcomes = await Promise.all(runners.map((r) => r.runOnce(job, day)));
    expect(outcomes.filter((o) => o === "ran")).toHaveLength(1);
    expect(outcomes.every((o) => ["ran", "locked", "done-before"].includes(o))).toBe(true);
    expect(puts).toBe(1);
    const run = await db.admin.query("SELECT status, attempts, detail FROM eureka.job_run WHERE job_name = 'audit-export' AND run_key = $1", [day]);
    expect(run.rows[0]).toMatchObject({ status: "succeeded", attempts: 1, detail: { rowCount: 1, skipped: false } });
    // And again later: already done.
    expect(await runners[0]!.runOnce(job, day)).toBe("done-before");
    expect(puts).toBe(1);
  });

  it("a failed run is recorded and retried on the next pass", async () => {
    let fail = true;
    const job: JobDefinition = {
      name: "flaky", dueKeys: () => ["k1"],
      run: async () => { if (fail) throw new Error("boom"); return { ok: true }; },
    };
    const runner = new JobRunner(db.worker, [job], silentLogger);
    expect(await runner.runOnce(job, "k1")).toBe("failed");
    let row = await db.admin.query("SELECT status, attempts, detail FROM eureka.job_run WHERE job_name = 'flaky'");
    expect(row.rows[0]).toMatchObject({ status: "failed", attempts: 1, detail: { error: "boom" } });
    fail = false;
    await runner.tick();
    row = await db.admin.query("SELECT status, attempts FROM eureka.job_run WHERE job_name = 'flaky'");
    expect(row.rows[0]).toMatchObject({ status: "succeeded", attempts: 2 });
  });

  it("stop() waits for the running job within the grace period", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let finished = false;
    const job: JobDefinition = {
      name: "slow", dueKeys: () => ["k1"],
      run: async () => { await gate; finished = true; return {}; },
    };
    const runner = new JobRunner(db.worker, [job], silentLogger);
    runner.start(60_000);
    await new Promise((r) => setTimeout(r, 200));
    setTimeout(release, 300);
    expect(await runner.stop(5_000)).toBe(true);
    expect(finished).toBe(true);

    // A job that outlives the grace period: stop() returns false on time and
    // the abort signal reaches the job (which then gives up and is marked failed).
    let aborted!: () => void;
    const sawAbort = new Promise<void>((r) => { aborted = r; });
    const stuck: JobDefinition = {
      name: "stuck", dueKeys: () => ["k1"],
      run: (_key, ctx) => new Promise((_res, rej) => ctx.signal.addEventListener("abort", () => {
        aborted(); setTimeout(() => rej(new Error("aborted")), 50);
      })),
    };
    const r2 = new JobRunner(workerPool(), [stuck], silentLogger);
    r2.start(60_000);
    await new Promise((r) => setTimeout(r, 200));
    const t0 = Date.now();
    expect(await r2.stop(300)).toBe(false);
    expect(Date.now() - t0).toBeLessThan(2_000);
    await sawAbort;
    await new Promise((r) => setTimeout(r, 300));
    const row = await db.admin.query("SELECT status FROM eureka.job_run WHERE job_name = 'stuck'");
    expect(row.rows[0].status).toBe("failed");
  });
});

describe("worker privileges (least privilege)", () => {
  async function denied(sql: string, params: unknown[] = []): Promise<string> {
    const err = await db.worker.query(sql, params).then(() => null, (e: Error) => e);
    expect(err, sql).not.toBeNull();
    return err!.message;
  }

  it("cannot update, delete or truncate the export ledger", async () => {
    expect(await denied("UPDATE eureka.audit_export SET row_count = 0")).toMatch(/permission denied/);
    expect(await denied("DELETE FROM eureka.audit_export")).toMatch(/permission denied/);
    expect(await denied("TRUNCATE eureka.audit_export")).toMatch(/permission denied/);
  });

  it("the ledger is immutable even for its owner", async () => {
    await expect(db.admin.query("UPDATE eureka.audit_export SET row_count = 0")).rejects.toThrow(/append-only/);
    await expect(db.admin.query("DELETE FROM eureka.audit_export")).rejects.toThrow(/append-only/);
    await expect(db.admin.query("TRUNCATE eureka.audit_export")).rejects.toThrow(/append-only/);
  });

  it("cannot insert a ledger row for today or later", async () => {
    const today = new Date().toISOString().slice(0, 10);
    expect(await denied(
      `INSERT INTO eureka.audit_export (export_date, object_key, row_count, byte_size, sha256_hex)
       VALUES ($1, 'x', 0, 20, repeat('a', 64))`, [today])).toMatch(/row-level security/);
  });

  it("cannot change audit events or delete job history", async () => {
    expect(await denied("UPDATE eureka.audit_event SET action = 'x'")).toMatch(/permission denied/);
    expect(await denied("DELETE FROM eureka.audit_event")).toMatch(/permission denied/);
    expect(await denied("DELETE FROM eureka.job_run")).toMatch(/permission denied/);
    expect(await denied("UPDATE eureka.job_run SET job_name = 'x'")).toMatch(/permission denied/);
    // A succeeded run cannot be reopened.
    const r = await db.worker.query(
      "UPDATE eureka.job_run SET status = 'running', finished_at = NULL WHERE status = 'succeeded'");
    expect(r.rowCount).toBe(0);
  });

  it("reads audit events of closed UTC days only", async () => {
    await db.app.query("SELECT 1"); // app pool warm
    const c = await db.app.connect();
    try {
      await c.query("BEGIN");
      await new AuditService().record(c, { actorId: U.r1a, action: "today.event", entityType: "candidate" });
      await c.query("COMMIT");
    } finally {
      c.release();
    }
    const all = await db.admin.query("SELECT count(*)::int AS n FROM eureka.audit_event WHERE action = 'today.event'");
    expect(all.rows[0].n).toBe(1);
    const seen = await db.worker.query("SELECT count(*)::int AS n FROM eureka.audit_event WHERE action = 'today.event'");
    expect(seen.rows[0].n).toBe(0);
  });

  it("cannot read domain, identity or session tables beyond its grants", async () => {
    for (const t of ["person", "candidate", "submission", "session", "role_request"]) {
      expect(await denied(`SELECT * FROM eureka.${t} LIMIT 1`)).toMatch(/permission denied/);
    }
    // The app's policies do not apply to the worker (membership is NOINHERIT).
    expect(await denied("SELECT phone_e164 FROM eureka.person LIMIT 1")).toMatch(/permission denied/);
  });

  it("owns no tables and holds no CREATE on schemas or the database", async () => {
    const r = await db.admin.query(`
      SELECT has_schema_privilege('eureka_worker', 'eureka', 'CREATE') AS eureka_create,
             has_schema_privilege('eureka_worker', 'public', 'CREATE') AS public_create,
             has_database_privilege('eureka_worker', current_database(), 'CREATE') AS db_create`);
    expect(r.rows[0]).toEqual({ eureka_create: false, public_create: false, db_create: false });
  });
});

describe("schedule", () => {
  it("audit export of a UTC day is due at 03:30 America/New_York the next day (EST and EDT)", () => {
    expect(dailyDueAt("2026-01-15", 3, 30, "America/New_York").toISOString()).toBe("2026-01-16T08:30:00.000Z");
    expect(dailyDueAt("2026-07-15", 3, 30, "America/New_York").toISOString()).toBe("2026-07-16T07:30:00.000Z");
    // DST starts 2026-03-08 at 02:00 local; 03:30 exists that day (EDT).
    expect(dailyDueAt("2026-03-07", 3, 30, "America/New_York").toISOString()).toBe("2026-03-08T07:30:00.000Z");
    // DST ends 2026-11-01; 03:30 that day is EST.
    expect(dailyDueAt("2026-10-31", 3, 30, "America/New_York").toISOString()).toBe("2026-11-01T08:30:00.000Z");
  });

  it("lists due keys oldest first with catch-up", () => {
    expect(dueDailyKeys(new Date("2026-07-16T07:29:00Z"), 3, 30, "America/New_York", 3)).toEqual(["2026-07-13", "2026-07-14"]);
    expect(dueDailyKeys(new Date("2026-07-16T07:30:00Z"), 3, 30, "America/New_York", 3)).toEqual(["2026-07-13", "2026-07-14", "2026-07-15"]);
    expect(dueDailyKeys(new Date("2026-07-16T23:00:00Z"), 3, 30, "America/New_York", 1)).toEqual(["2026-07-15"]);
  });
});

describe("worker config", () => {
  const base = { DATABASE_URL: "postgres://w:p@db:5432/eureka" };
  it("requires exactly one export target and S3 in production", () => {
    expect(() => loadWorkerConfig(base)).toThrow(/AUDIT_BUCKET/);
    expect(() => loadWorkerConfig({ ...base, AUDIT_BUCKET: "b-123", EXPORT_DIR: "/tmp/x" })).toThrow(/only one/);
    expect(() => loadWorkerConfig({ ...base, NODE_ENV: "production", EXPORT_DIR: "/tmp/x" })).toThrow(/required in production/);
    expect(loadWorkerConfig({ ...base, NODE_ENV: "production", AUDIT_BUCKET: "b-123" }).SHUTDOWN_GRACE_SECONDS).toBe(20);
  });
});

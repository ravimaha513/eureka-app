import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AuditService } from "../src/platform/audit.service.js";
import { loadWorkerConfig } from "../src/worker/config.js";
import { auditExportJob, auditObjectKey, dueAuditDays, exportAuditDay } from "../src/worker/jobs/audit-export.js";
import { createLogger, silentLogger } from "../src/worker/log.js";
import { JobRunner, backoffMs, type JobDefinition } from "../src/worker/runner.js";
import { dailyDueAt, dueDailyKeys, latestDueDailyKey } from "../src/worker/schedule.js";
import { DirSink, S3Sink, type ExportSink } from "../src/worker/sink.js";
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
  await audit("2026-02-10T08:00:00Z", "candidate.created", { note: "for the byte cap test" });
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
    const opts: unknown[] = [];
    const s3 = { send: async (cmd: { input: Record<string, unknown> }, o?: unknown) => {
      sent.push(cmd.input); opts.push(o); return {};
    } };
    const sink = new S3Sink(s3 as never, "eureka-prod-audit-123");
    const ac = new AbortController();
    const r = await exportAuditDay(db.worker, sink, "2026-03-09", { signal: ac.signal });
    expect(r).toMatchObject({ rowCount: 1, put: "written" });
    expect(sent).toHaveLength(1);
    expect(opts[0]).toEqual({ abortSignal: ac.signal });
    const input = sent[0]!;
    expect(input.IfNoneMatch).toBe("*");
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
    const counting: ExportSink = { kind: "dir", put: async (k, b, h) => { puts++; return dir.put(k, b, h); } };
    const job = auditExportJob(counting, 3);
    const runners = [0, 1, 2].map(() => new JobRunner(workerPool(), [job], silentLogger));
    const outcomes = await Promise.all(runners.map((r) => r.runOnce(job, day)));
    expect(outcomes.filter((o) => o === "ran")).toHaveLength(1);
    expect(outcomes.every((o) => ["ran", "leased", "done-before"].includes(o))).toBe(true);
    expect(puts).toBe(1);
    const run = await db.admin.query("SELECT status, attempts, detail FROM eureka.job_run WHERE job_name = 'audit-export' AND run_key = $1", [day]);
    expect(run.rows[0]).toMatchObject({ status: "succeeded", attempts: 1, detail: { rowCount: 1, skipped: false } });
    // And again later: already done.
    expect(await runners[0]!.runOnce(job, day)).toBe("done-before");
    expect(puts).toBe(1);
  });

  it("catches up every missing day since the ledger started, capped per tick, and alerts when behind", async () => {
    // Ledger so far: 03-01, 03-09, 03-10, 03-11. "Now" is 2026-03-20 12:00 UTC, so 03-19 is due.
    const now = new Date("2026-03-20T12:00:00Z");
    const lines: Record<string, unknown>[] = [];
    const log = createLogger({}, (l) => lines.push(JSON.parse(l)));
    const dir = new DirSink(exportDir);
    const job = auditExportJob(dir, 3);
    expect(await job.dueKeys(now, { pool: db.worker, log })).toEqual(["2026-03-02", "2026-03-03", "2026-03-04"]);
    const alert = lines.find((l) => l.msg === "audit export is behind");
    expect(alert).toMatchObject({ level: "error", alert: true, lastExported: "2026-03-11", yesterday: "2026-03-19", daysBehind: 8 });

    await new JobRunner(db.worker, [job], log).tick(now);
    const ledger = await db.admin.query<{ d: string }>(
      "SELECT export_date::text AS d FROM eureka.audit_export WHERE export_date BETWEEN '2026-03-02' AND '2026-03-04' ORDER BY 1");
    expect(ledger.rows.map((r) => r.d)).toEqual(["2026-03-02", "2026-03-03", "2026-03-04"]);
    // The alert is throttled (once an hour per process).
    expect(lines.filter((l) => l.msg === "audit export is behind")).toHaveLength(1);

    const due = await dueAuditDays(db.worker, now, 100);
    expect(due.days).toEqual([
      "2026-03-05", "2026-03-06", "2026-03-07", "2026-03-08",
      ...Array.from({ length: 8 }, (_, i) => `2026-03-${String(12 + i).padStart(2, "0")}`)]);
    // Before 03:30 New York time the previous UTC day is not yet due.
    expect((await dueAuditDays(db.worker, new Date("2026-03-20T07:00:00Z"), 100)).lastDue).toBe("2026-03-18");
  });

  it("a failed run is recorded, backs off exponentially and is retried once due", async () => {
    let fail = true;
    const job: JobDefinition = {
      name: "flaky", dueKeys: () => ["k1"],
      run: async () => { if (fail) throw new Error("boom"); return { ok: true }; },
    };
    const lines: Record<string, unknown>[] = [];
    const log = createLogger({}, (l) => lines.push(JSON.parse(l)));
    const runner = new JobRunner(db.worker, [job], log, undefined, { backoffBaseMs: 60_000, maxAttempts: 2 });
    expect(await runner.runOnce(job, "k1")).toBe("failed");
    let row = await db.admin.query(`SELECT status, attempts, detail, lease_until,
        extract(epoch FROM next_attempt_at - now()) AS wait FROM eureka.job_run WHERE job_name = 'flaky'`);
    expect(row.rows[0]).toMatchObject({ status: "failed", attempts: 1, detail: { error: "boom" }, lease_until: null });
    expect(Number(row.rows[0].wait)).toBeGreaterThan(55);
    expect(Number(row.rows[0].wait)).toBeLessThanOrEqual(60);
    // Not claimable during the backoff.
    expect(await runner.runOnce(job, "k1")).toBe("backoff");

    // Second failure: twice the delay, and an alert (maxAttempts reached).
    await db.admin.query("UPDATE eureka.job_run SET next_attempt_at = now() - interval '1 second' WHERE job_name = 'flaky'");
    expect(await runner.runOnce(job, "k1")).toBe("failed");
    row = await db.admin.query(
      "SELECT attempts, extract(epoch FROM next_attempt_at - now()) AS wait FROM eureka.job_run WHERE job_name = 'flaky'");
    expect(row.rows[0].attempts).toBe(2);
    expect(Number(row.rows[0].wait)).toBeGreaterThan(115);
    expect(lines.filter((l) => l.msg === "job failed repeatedly" && l.alert === true)).toHaveLength(1);

    fail = false;
    await db.admin.query("UPDATE eureka.job_run SET next_attempt_at = now() - interval '1 second' WHERE job_name = 'flaky'");
    await runner.tick();
    row = await db.admin.query("SELECT status, attempts, next_attempt_at FROM eureka.job_run WHERE job_name = 'flaky'");
    expect(row.rows[0]).toMatchObject({ status: "succeeded", attempts: 3, next_attempt_at: null });

    expect([1, 2, 3, 4, 20].map((a) => backoffMs(a, { backoffBaseMs: 60_000, backoffMaxMs: 3600_000 })))
      .toEqual([60_000, 120_000, 240_000, 480_000, 3600_000]);
  });

  it("a live lease blocks a second runner; an expired one is taken over and the old runner is fenced off", async () => {
    let aborted = false;
    const holder: JobDefinition = {
      name: "leased", dueKeys: () => [],
      run: (_key, ctx) => new Promise((_res, rej) => ctx.signal.addEventListener("abort", () => {
        aborted = true; rej(new Error("lease lost"));
      })),
    };
    let runs = 0;
    const other: JobDefinition = { name: "leased", dueKeys: () => [], run: async () => { runs++; return { by: "b" }; } };
    const a = new JobRunner(workerPool(), [holder], silentLogger, undefined, { leaseMs: 60_000, renewMs: 100 });
    const b = new JobRunner(workerPool(), [other], silentLogger, undefined, { leaseMs: 60_000 });

    const aDone = a.runOnce(holder, "k1");
    await new Promise((r) => setTimeout(r, 300));
    // A renews its lease: B cannot run the key.
    expect(await b.runOnce(other, "k1")).toBe("leased");
    expect(runs).toBe(0);
    let row = await db.admin.query(
      "SELECT status, attempts, lease_until > now() + interval '50 seconds' AS live FROM eureka.job_run WHERE job_name = 'leased'");
    expect(row.rows[0]).toEqual({ status: "running", attempts: 1, live: true });

    // A's lease expires (its connection or process died, say): B takes over.
    await db.admin.query("UPDATE eureka.job_run SET lease_until = now() - interval '1 second' WHERE job_name = 'leased'");
    expect(await b.runOnce(other, "k1")).toBe("ran");
    expect(runs).toBe(1);

    // A notices at its next renewal, aborts, and cannot overwrite B's outcome.
    expect(await aDone).toBe("lease-lost");
    expect(aborted).toBe(true);
    row = await db.admin.query("SELECT status, attempts, detail FROM eureka.job_run WHERE job_name = 'leased'");
    expect(row.rows[0]).toEqual({ status: "succeeded", attempts: 2, detail: { by: "b" } });
  });

  it("a runner that notices its expired lease before anyone takes over records nothing, so the next runner can claim at once", async () => {
    let aborted = false;
    const holder: JobDefinition = {
      name: "expired", dueKeys: () => [],
      run: (_key, ctx) => new Promise((_res, rej) => ctx.signal.addEventListener("abort", () => {
        aborted = true; rej(new Error("lease lost"));
      })),
    };
    let runs = 0;
    const other: JobDefinition = { name: "expired", dueKeys: () => [], run: async () => { runs++; return { by: "b" }; } };
    const a = new JobRunner(workerPool(), [holder], silentLogger, undefined, { leaseMs: 60_000, renewMs: 50 });
    const b = new JobRunner(workerPool(), [other], silentLogger, undefined, { leaseMs: 60_000 });

    const aDone = a.runOnce(holder, "k1");
    await new Promise((r) => setTimeout(r, 150));
    // The lease expires and A notices at its next renewal, before B tries: the ordering CI hit.
    await db.admin.query("UPDATE eureka.job_run SET lease_until = now() - interval '1 second' WHERE job_name = 'expired'");
    expect(await aDone).toBe("lease-lost");
    expect(aborted).toBe(true);
    let row = await db.admin.query("SELECT status, attempts, next_attempt_at, detail FROM eureka.job_run WHERE job_name = 'expired'");
    expect(row.rows[0]).toEqual({ status: "running", attempts: 1, next_attempt_at: null, detail: null });

    // No backoff was recorded, so B claims straight away.
    expect(await b.runOnce(other, "k1")).toBe("ran");
    expect(runs).toBe(1);
    row = await db.admin.query("SELECT status, attempts, detail FROM eureka.job_run WHERE job_name = 'expired'");
    expect(row.rows[0]).toEqual({ status: "succeeded", attempts: 2, detail: { by: "b" } });
  });

  it("an object already in the bucket with the same checksum (412) counts as written", async () => {
    const day = "2026-03-06";
    const stored = new Map<string, string>();
    const calls: string[] = [];
    const s3 = { send: async (cmd: { input: Record<string, unknown> }) => {
      const key = cmd.input.Key as string;
      if (cmd instanceof PutObjectCommand) {
        calls.push("put");
        expect(cmd.input.IfNoneMatch).toBe("*");
        if (stored.has(key)) {
          throw Object.assign(new Error("At least one of the pre-conditions you specified did not hold"),
            { name: "PreconditionFailed", $metadata: { httpStatusCode: 412 } });
        }
        stored.set(key, cmd.input.ChecksumSHA256 as string);
        return {};
      }
      if (cmd instanceof HeadObjectCommand) {
        calls.push("head");
        expect(cmd.input.ChecksumMode).toBe("ENABLED");
        return { ChecksumSHA256: stored.get(key) };
      }
      throw new Error("unexpected command");
    } };
    const sink = new S3Sink(s3 as never, "audit-bucket");

    // An earlier attempt uploaded the day, then failed before its ledger insert
    // (simulated by a sink that uploads and then throws).
    await expect(exportAuditDay(db.worker, { kind: "s3", put: async (...a) => {
      await sink.put(...a); throw new Error("connection reset before the ledger insert");
    } }, day)).rejects.toThrow(/connection reset/);
    let n = await db.admin.query("SELECT count(*)::int AS n FROM eureka.audit_export WHERE export_date = $1", [day]);
    expect(n.rows[0].n).toBe(0);
    const firstSum = stored.get(auditObjectKey(day));

    // The retry produces identical bytes: 412, HeadObject checksum matches, ledger row inserted.
    calls.length = 0;
    const r = await exportAuditDay(db.worker, sink, day);
    expect(r).toMatchObject({ put: "existed", skipped: false });
    expect(calls).toEqual(["put", "head"]);
    n = await db.admin.query("SELECT sha256_hex FROM eureka.audit_export WHERE export_date = $1", [day]);
    expect(Buffer.from(n.rows[0].sha256_hex, "hex").toString("base64")).toBe(firstSum);

    // A different object under the key of an unexported day: refused, no ledger row.
    const other = "2026-03-07";
    stored.set(auditObjectKey(other), createHash("sha256").update("not the export").digest("base64"));
    await expect(exportAuditDay(db.worker, sink, other)).rejects.toThrow(/already exists with different content/);
    n = await db.admin.query("SELECT count(*)::int AS n FROM eureka.audit_export WHERE export_date = $1", [other]);
    expect(n.rows[0].n).toBe(0);
  });

  it("the directory sink is create-only too", async () => {
    const sink = new DirSink(join(exportDir, "create-only"));
    const a = Buffer.from("same");
    const h = createHash("sha256").update(a).digest();
    expect(await sink.put("audit/x.gz", a, h)).toBe("written");
    expect(await sink.put("audit/x.gz", a, h)).toBe("existed");
    const b = Buffer.from("other");
    await expect(sink.put("audit/x.gz", b, createHash("sha256").update(b).digest())).rejects.toThrow(/different content/);
  });

  it("a day larger than the byte cap fails explicitly and leaves no ledger row", async () => {
    await expect(exportAuditDay(db.worker, new DirSink(exportDir), "2026-02-10", { maxBytes: 10 }))
      .rejects.toThrow(/exceeds 10 bytes uncompressed/);
    const n = await db.admin.query("SELECT count(*)::int AS n FROM eureka.audit_export WHERE export_date = '2026-02-10'");
    expect(n.rows[0].n).toBe(0);
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

  it("cannot forge job_run history", async () => {
    const lease = "now() + interval '1 minute'";
    // Inserts start as running.
    expect(await denied(`INSERT INTO eureka.job_run (job_name, run_key, status, lease_until)
      VALUES ('audit-export', '2026-01-05', 'succeeded', NULL)`)).toMatch(/row-level security/);
    // An audit-export run cannot be marked succeeded without its ledger row.
    await db.worker.query(`INSERT INTO eureka.job_run (job_name, run_key, status, lease_until)
      VALUES ('audit-export', '2026-01-05', 'running', ${lease})`);
    expect(await denied(`UPDATE eureka.job_run SET status = 'succeeded', lease_until = NULL
      WHERE job_name = 'audit-export' AND run_key = '2026-01-05'`)).toMatch(/row-level security/);
    // Timestamps are the database's, not the worker's.
    await db.worker.query(`INSERT INTO eureka.job_run (job_name, run_key, status, lease_until, started_at)
      VALUES ('forge', 'k1', 'running', ${lease}, '2000-01-01')`);
    await db.worker.query(`UPDATE eureka.job_run SET status = 'failed', lease_until = NULL,
      started_at = '2000-01-01', finished_at = '2000-01-02' WHERE job_name = 'forge'`);
    const row = await db.admin.query(`SELECT started_at > now() - interval '1 minute' AS s_now,
      finished_at > now() - interval '1 minute' AS f_now FROM eureka.job_run WHERE job_name = 'forge'`);
    expect(row.rows[0]).toEqual({ s_now: true, f_now: true });
    // Attempts grow by one per claim only.
    expect(await denied(`UPDATE eureka.job_run SET status = 'running', attempts = attempts + 5, lease_until = ${lease}
      WHERE job_name = 'forge'`)).toMatch(/attempts may only grow by one/);
    // Leases and backoff are bounded.
    expect(await denied(`UPDATE eureka.job_run SET status = 'running', attempts = attempts + 1,
      lease_until = now() + interval '2 hours' WHERE job_name = 'forge'`)).toMatch(/row-level security/);
    expect(await denied(`UPDATE eureka.job_run SET next_attempt_at = now() + interval '30 days'
      WHERE job_name = 'forge'`)).toMatch(/row-level security/);
  });

  it("rejects run keys in the future", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const ins = (job: string, key: string) => db.worker.query(
      `INSERT INTO eureka.job_run (job_name, run_key, status, lease_until)
       VALUES ($1, $2, 'running', now() + interval '1 minute')`, [job, key]);
    await expect(ins("some-daily", tomorrow)).rejects.toThrow(/in the future/);
    await expect(ins("audit-export", today)).rejects.toThrow(/in the future/);
    await expect(ins("some-daily", today)).resolves.toBeDefined();
  });

  it("audit_event has the (at, seq) index the export pages on", async () => {
    const r = await db.admin.query(
      "SELECT indexdef FROM pg_indexes WHERE schemaname = 'eureka' AND indexname = 'audit_event_at_seq'");
    expect(r.rows[0]?.indexdef).toMatch(/ON eureka\.audit_event USING btree \(at, seq\)/);
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

  it("the latest due day is yesterday once 03:30 New York time has passed", () => {
    expect(latestDueDailyKey(new Date("2026-07-16T07:29:00Z"), 3, 30, "America/New_York")).toBe("2026-07-14");
    expect(latestDueDailyKey(new Date("2026-07-16T07:30:00Z"), 3, 30, "America/New_York")).toBe("2026-07-15");
    expect(latestDueDailyKey(new Date("2026-01-16T08:29:00Z"), 3, 30, "America/New_York")).toBe("2026-01-14");
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
    const kms = { AWS_REGION: "us-east-2", FIELD_KMS_KEY_ARN: "arn:aws:kms:us-east-2:123456789012:key/1234abcd-12ab-34cd-56ef-1234567890ab" };
    expect(loadWorkerConfig({ ...base, ...kms, NODE_ENV: "production", AUDIT_BUCKET: "b-123" }).SHUTDOWN_GRACE_SECONDS).toBe(20);
  });
});

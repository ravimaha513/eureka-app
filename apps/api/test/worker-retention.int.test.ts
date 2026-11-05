import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadWorkerConfig } from "../src/worker/config.js";
import {
  AUDIT_RETENTION_JOB, auditRetentionJob, rateLimitPurgeJob, ratePurgeAvailable, sessionRetentionJob,
} from "../src/worker/jobs/retention.js";
import { silentLogger } from "../src/worker/log.js";
import { JobRunner, stopRunners, type JobDefinition } from "../src/worker/runner.js";
import { createTestDb, type TestDb } from "./db-harness.js";
import { U, seedFixtures } from "./fixtures.js";

/**
 * Worker lanes (F-10: outbox delivery never waits behind long jobs) and the
 * retention jobs of migration 0488 (G-08): sessions, step-up rows, applicant
 * sessions, opt-in audit archival, the shared rate-limit purge.
 */
let db: TestDb;

/** Superuser write with triggers off (time travel in test setup only). */
async function force(sql: string, params: unknown[] = []) {
  const c = await db.admin.connect();
  try {
    await c.query("BEGIN");
    await c.query("SET LOCAL session_replication_role = replica");
    await c.query(sql, params);
    await c.query("COMMIT");
  } finally {
    c.release();
  }
}
const err = (p: Promise<unknown>) => p.then(() => "allowed", (e: Error) => e.message);
const ctx = () => ({ pool: db.worker, log: silentLogger, signal: new AbortController().signal, heartbeat() {} });

/** A staff session that expired `expiredDaysAgo` days ago (negative: still live), optionally revoked. */
async function staffSession(expiredDaysAgo: number, revokedDaysAgo?: number): Promise<Buffer> {
  const h = randomBytes(32);
  await db.admin.query(
    `INSERT INTO eureka.session (id_hash, user_id, created_at, last_seen_at, expires_at, auth_time, access_version, revoked_at)
     VALUES ($1, $2, now() - make_interval(days => $3 + 1), now() - make_interval(days => $3 + 1),
             now() - make_interval(days => $3), now() - make_interval(days => $3 + 1), 1,
             CASE WHEN $4::int IS NULL THEN NULL ELSE now() - make_interval(days => $4::int) END)`,
    [h, U.r1a, expiredDaysAgo, revokedDaysAgo ?? null]);
  return h;
}
async function stepUp(session: Buffer, expiredDaysAgo: number): Promise<void> {
  await force(
    `INSERT INTO eureka.step_up_challenge (state_hash, session_hash, user_id, nonce_hash, return_to, created_at, expires_at)
     VALUES ($1, $2, $3, $4, '/documents', now() - make_interval(days => $5) - interval '10 minutes', now() - make_interval(days => $5))`,
    [randomBytes(32), session, U.r1a, randomBytes(32), expiredDaysAgo]);
  await force(
    `INSERT INTO eureka.step_up_grant (session_hash, user_id, method, auth_time, created_at, expires_at)
     VALUES ($1, $2, 'dev', now() - make_interval(days => $3) - interval '10 minutes',
             now() - make_interval(days => $3) - interval '10 minutes', now() - make_interval(days => $3))`,
    [session, U.r1a, expiredDaysAgo]);
}
const exists = async (table: string, col: string, v: unknown) =>
  ((await db.admin.query(`SELECT 1 FROM eureka.${table} WHERE ${col} = $1`, [v])).rowCount ?? 0) > 0;
const count = async (sql: string, params: unknown[] = []) => (await db.admin.query<{ n: number }>(sql, params)).rows[0]!.n;

beforeAll(async () => {
  db = await createTestDb();
  await seedFixtures(db.admin);
}, 120_000);

afterAll(async () => {
  await db?.drop();
});

describe("worker lanes (F-10)", () => {
  it("outbox delivery keeps running while a long scheduled job holds the other lane; shutdown drains both", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let longDone = false;
    const long: JobDefinition = {
      name: "lane-long", dueKeys: () => ["k1"],
      run: async () => { await gate; longDone = true; return {}; },
    };
    let deliveries = 0;
    let n = 0;
    const outbox: JobDefinition = {
      name: "lane-outbox", dueKeys: () => [`e${++n}`],
      run: async () => { deliveries++; return {}; },
    };
    const scheduled = new JobRunner(db.worker, [long], silentLogger);
    const outboxLane = new JobRunner(db.worker, [outbox], silentLogger);
    scheduled.start(60_000);
    outboxLane.start(50);
    const t0 = Date.now();
    while (deliveries < 3 && Date.now() - t0 < 5_000) await new Promise((r) => setTimeout(r, 25));
    expect(deliveries).toBeGreaterThanOrEqual(3);   // delivered while the long job is still running
    expect(longDone).toBe(false);

    setTimeout(release, 200);
    expect(await stopRunners([scheduled, outboxLane], 5_000)).toBe(true);
    expect(longDone).toBe(true);
    const settled = deliveries;
    await new Promise((r) => setTimeout(r, 150));
    expect(deliveries).toBe(settled);                // nothing runs after stop
    const rows = await db.admin.query<{ status: string }>("SELECT status FROM eureka.job_run WHERE job_name LIKE 'lane-%'");
    expect(rows.rows.every((r) => r.status === "succeeded")).toBe(true);
  });

  it("a lane that outlives the grace period reports an unclean stop", async () => {
    const stuck: JobDefinition = {
      name: "lane-stuck", dueKeys: () => ["k1"],
      run: (_key, c) => new Promise((_res, rej) => c.signal.addEventListener("abort", () => rej(new Error("aborted")))),
    };
    const a = new JobRunner(db.worker, [stuck], silentLogger);
    const b = new JobRunner(db.worker, [], silentLogger);
    a.start(60_000);
    b.start(60_000);
    await new Promise((r) => setTimeout(r, 200));
    expect(await stopRunners([a, b], 200)).toBe(false);
  });

  it("config: two lanes need a pool of four by default; the outbox tick is short", () => {
    const c = loadWorkerConfig({ DATABASE_URL: "postgres://w@h/d", EXPORT_DIR: "/tmp/x" });
    expect(c).toMatchObject({ DB_POOL_MAX: 4, OUTBOX_TICK_SECONDS: 10, JOB_TICK_SECONDS: 60 });
  });
});

describe("session retention (G-08, migration 0488)", () => {
  it("deletes ended staff sessions (with their step-up rows), expired step-up rows and ended applicant sessions past the cut-off only", async () => {
    const old = await staffSession(40);              // expired 40 days ago
    const revoked = await staffSession(-1, 35);      // revoked 35 days ago (would still be live)
    const recent = await staffSession(10);           // expired 10 days ago: kept (login activity)
    const live = await staffSession(-1);             // live
    await stepUp(old, 40);                           // goes with its session
    await stepUp(live, 10);                          // expired step-up on a live session: pruned
    await stepUp(recent, 3);                         // within STEP_UP_RETENTION_DAYS: kept

    const applicant = (await db.admin.query<{ id: string }>("SELECT gen_random_uuid() AS id")).rows[0]!.id;
    await force(`INSERT INTO eureka.applicant (id, first_name, last_name, email, email_verified_at)
      VALUES ($1, 'Ann', 'Applicant', 'ann.retention@example.com', now() - interval '90 days')`, [applicant]);
    const appSession = async (expiredDaysAgo: number) => {
      const h = randomBytes(32);
      await force(`INSERT INTO eureka.applicant_session (id_hash, applicant_id, created_at, last_seen_at, expires_at)
        VALUES ($1, $2, now() - make_interval(days => $3 + 1), now() - make_interval(days => $3 + 1), now() - make_interval(days => $3))`,
      [h, applicant, expiredDaysAgo]);
      return h;
    };
    const appOld = await appSession(45);
    const appRecent = await appSession(5);

    const job = sessionRetentionJob();
    const runner = new JobRunner(db.worker, [job], silentLogger);
    const [key] = await job.dueKeys(new Date(), { pool: db.worker, log: silentLogger }) as string[];
    expect(await runner.runOnce(job, key ?? "2026-01-01")).toBe("ran");
    const detail = (await db.admin.query("SELECT detail FROM eureka.job_run WHERE job_name = 'session-retention'")).rows[0].detail;
    expect(detail).toMatchObject({ sessionDays: 30, stepUpDays: 7 });
    expect(detail.sessions).toBeGreaterThanOrEqual(2);
    expect(detail.stepUp).toBeGreaterThanOrEqual(2);
    expect(detail.applicantSessions).toBeGreaterThanOrEqual(1);

    expect(await exists("session", "id_hash", old)).toBe(false);
    expect(await exists("session", "id_hash", revoked)).toBe(false);
    expect(await exists("session", "id_hash", recent)).toBe(true);
    expect(await exists("session", "id_hash", live)).toBe(true);
    expect(await count("SELECT count(*)::int AS n FROM eureka.step_up_grant WHERE session_hash = $1", [old])).toBe(0);
    expect(await count("SELECT count(*)::int AS n FROM eureka.step_up_grant WHERE session_hash = $1", [live])).toBe(0);
    expect(await count("SELECT count(*)::int AS n FROM eureka.step_up_challenge WHERE session_hash = $1", [live])).toBe(0);
    expect(await count("SELECT count(*)::int AS n FROM eureka.step_up_grant WHERE session_hash = $1", [recent])).toBe(1);
    expect(await count("SELECT count(*)::int AS n FROM eureka.step_up_challenge WHERE session_hash = $1", [recent])).toBe(1);
    expect(await exists("applicant_session", "id_hash", appOld)).toBe(false);
    expect(await exists("applicant_session", "id_hash", appRecent)).toBe(true);
    expect(await exists("applicant", "id", applicant)).toBe(true);      // a verified applicant is never deleted here
  });

  it("the database refuses short retention; only the worker may call the functions; nobody gains direct deletes", async () => {
    expect(await err(db.worker.query("SELECT eureka.prune_staff_sessions(29)"))).toMatch(/between 30 and 3650/);
    expect(await err(db.worker.query("SELECT eureka.prune_staff_sessions(NULL)"))).toMatch(/between 30 and 3650/);
    expect(await err(db.worker.query("SELECT eureka.prune_step_up(0)"))).toMatch(/between 1 and 365/);
    expect(await err(db.worker.query("SELECT authz.prune_applicant_sessions(7)"))).toMatch(/between 30 and 3650/);
    expect(await err(db.worker.query("SELECT eureka.audit_prune_exported(364)"))).toMatch(/between 365 and 36500/);
    expect(() => sessionRetentionJob({ sessionDays: 29, stepUpDays: 7 })).toThrow(/30 to 3650/);
    expect(() => auditRetentionJob(100)).toThrow(/365 to 36500/);

    const fns = ["eureka.prune_staff_sessions(integer)", "eureka.prune_step_up(integer)",
      "authz.prune_applicant_sessions(integer)", "eureka.audit_prune_exported(integer)"];
    for (const fn of fns) {
      const r = await db.admin.query(`SELECT has_function_privilege('eureka_worker', $1, 'EXECUTE') AS w,
        has_function_privilege('eureka_app', $1, 'EXECUTE') AS a, has_function_privilege('authz_definer', $1, 'EXECUTE') AS d,
        has_function_privilege('public', $1, 'EXECUTE') AS p,
        (SELECT proconfig FROM pg_proc WHERE oid = $1::regprocedure) AS cfg`, [fn]);
      expect(r.rows[0], fn).toMatchObject({ w: true, a: false, p: false });
      expect(r.rows[0].cfg, fn).toContain("search_path=pg_catalog, pg_temp");
    }
    // No new direct DELETE for the worker or the API definer role.
    expect(await err(db.worker.query("DELETE FROM eureka.session"))).toMatch(/permission denied/);
    const priv = await db.admin.query(`SELECT has_table_privilege('authz_definer', 'eureka.session', 'DELETE') AS s,
      has_table_privilege('authz_definer', 'eureka.audit_event', 'DELETE') AS a,
      has_table_privilege('authz_definer', 'eureka.step_up_grant', 'DELETE') AS g`);
    expect(priv.rows[0]).toEqual({ s: false, a: false, g: false });
  });
});

describe("audit retention (opt-in archival)", () => {
  it("is off by default; when configured deletes only exported rows older than the retention", async () => {
    expect(loadWorkerConfig({ DATABASE_URL: "postgres://w@h/d", EXPORT_DIR: "/tmp/x" }).AUDIT_RETENTION_DAYS).toBeUndefined();
    expect(() => loadWorkerConfig({ DATABASE_URL: "postgres://w@h/d", EXPORT_DIR: "/tmp/x", AUDIT_RETENTION_DAYS: "90" })).toThrow();

    /** An audit row (as the superuser), then backdated; returns its seq. */
    const row = async (at?: string) => {
      const seq = String((await db.admin.query<{ seq: string }>(
        `INSERT INTO eureka.audit_event (action, entity_type) VALUES ('retention.test', 'candidate') RETURNING seq`)).rows[0]!.seq);
      if (at) await db.admin.query("UPDATE eureka.audit_event SET at = $2 WHERE seq = $1", [seq, at]);
      return seq;
    };
    const exportedOld = await row("2020-01-10T12:00:00Z");
    const unexportedOld = await row("2020-01-11T12:00:00Z");
    const outOfRange = await row("2020-01-10T13:00:00Z"); // same day, after the export's last_seq
    // A day whose file holds 1 row, but a second row of that day committed late with a seq in range:
    // the day is kept whole (neither row is pruned).
    const lateA = await row("2020-01-12T09:00:00Z");
    const lateB = await row("2020-01-12T09:30:00Z");
    const recent = await row();
    await db.admin.query(`INSERT INTO eureka.audit_export (export_date, object_key, row_count, first_seq, last_seq, byte_size, sha256_hex)
      VALUES ('2020-01-10', 'audit/2020/01/10/test.jsonl.gz', 1, $1, $1, 20, repeat('a', 64))`, [exportedOld]);
    await db.admin.query(`INSERT INTO eureka.audit_export (export_date, object_key, row_count, first_seq, last_seq, byte_size, sha256_hex)
      VALUES ('2020-01-12', 'audit/2020/01/12/test.jsonl.gz', 1, $1, $2, 20, repeat('c', 64))`, [lateA, lateB]);
    // Mark today's recent row as part of an export too: still too young.
    await db.admin.query(`INSERT INTO eureka.audit_export (export_date, object_key, row_count, first_seq, last_seq, byte_size, sha256_hex)
      VALUES ((now() AT TIME ZONE 'UTC')::date - 1, 'audit/recent/test.jsonl.gz', 1, $1, $1, 20, repeat('b', 64))`, [recent]);
    await db.admin.query("UPDATE eureka.audit_event SET at = now() - interval '1 day' WHERE seq = $1", [recent]);

    const job = auditRetentionJob(365);
    expect(job.name).toBe(AUDIT_RETENTION_JOB);
    const r = await job.run("2026-01-01", ctx());
    expect(r).toMatchObject({ deleted: 1, days: 365 });
    const left = (await db.admin.query("SELECT seq::text FROM eureka.audit_event WHERE action = 'retention.test'")).rows.map((x) => x.seq);
    expect(left.sort()).toEqual([unexportedOld, outOfRange, lateA, lateB, recent].sort());

    // The owner's delete policy (0488) still bounds any owner-run delete: unexported, out-of-range and
    // young rows never go. (The late-commit count rule lives in the function only; a policy cannot
    // read its own table.)
    const c = await db.admin.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL ROLE eureka_owner");
      const d = await c.query("DELETE FROM eureka.audit_event WHERE seq = ANY ($1::bigint[])", [[unexportedOld, outOfRange, recent]]);
      expect(d.rowCount).toBe(0);
    } finally {
      await c.query("ROLLBACK");
      c.release();
    }
    expect(await err(db.worker.query("DELETE FROM eureka.audit_event"))).toMatch(/permission denied/);
  });
});

describe("rate-limit purge (shared limiter, migrations 0486/0487)", () => {
  it("is a no-op until authz.rate_purge() exists, then calls it hourly", async () => {
    const job = rateLimitPurgeJob();
    expect(job.dueKeys(new Date("2026-11-05T14:03:00Z"), { pool: db.worker, log: silentLogger })).toEqual(["2026-11-05T13"]);
    expect(job.dueKeys(new Date("2026-11-05T14:06:00Z"), { pool: db.worker, log: silentLogger })).toEqual(["2026-11-05T14"]);
    const runner = new JobRunner(db.worker, [job], silentLogger);
    if (await ratePurgeAvailable(db.worker)) {
      // The limiter's migrations are merged: the real function runs.
      expect(await job.run("2026-11-05T14", ctx())).toMatchObject({ available: true });
      expect(await runner.runOnce(job, "2026-11-05T12")).toBe("ran");
      return;
    }
    expect(await job.run("2026-11-05T13", ctx())).toEqual({ available: false });
    // Stand-in for the limiter's function (dropped again).
    await db.admin.query(`CREATE FUNCTION authz.rate_purge() RETURNS integer LANGUAGE sql AS 'SELECT 3'`);
    await db.admin.query("GRANT EXECUTE ON FUNCTION authz.rate_purge() TO eureka_worker");
    try {
      expect(await job.run("2026-11-05T14", ctx())).toEqual({ available: true, deleted: 3 });
      expect(await runner.runOnce(job, "2026-11-05T12")).toBe("ran");
    } finally {
      await db.admin.query("DROP FUNCTION authz.rate_purge()");
    }
  });
});

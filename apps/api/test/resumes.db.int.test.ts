import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { candidateVisible, resolveScope, resumeAccess } from "@eureka/shared";
import { PLANNER_VARIANTS, asUser, createTestDb, rule3Probe, type Rule3Probe, type TestDb } from "./db-harness.js";
import { U, seedFixtures, toUserAccess, type FixtureCandidate } from "./fixtures.js";

/**
 * Database-only checks for migration 0036 (resumes): RLS alone matches the
 * engine, writes only through the definer functions, server-managed columns,
 * and the scan state machine (design B8: rules hold with the API removed).
 */
let db: TestDb;
let candidates: FixtureCandidate[];
const users = Object.keys(U) as (keyof typeof U)[];
const PDF = "application/pdf";
const SHA = "a".repeat(64);

beforeAll(async () => {
  db = await createTestDb();
  candidates = await seedFixtures(db.admin);
}, 120_000);

afterAll(async () => {
  await db?.drop();
});

const createUpload = (actor: string, candidateId: string, size = 1000, type = PDF, commit = true) =>
  asUser(db.app, actor, async (c) =>
    (await c.query<{ id: string; upload_expires_at: Date }>(`SELECT * FROM authz.create_resume_upload($1, $2, $3)`, [candidateId, type, size])).rows[0]!, commit);

const finish = (id: string, status: string, result: string, sha: string | null = null, size: number | null = null) =>
  db.worker.query<{ s: string }>(`SELECT authz.resume_scan_finish($1, $2, $3, $4, $5) AS s`, [id, status, result, sha, size]).then((r) => r.rows[0]!.s);

const row = async (id: string) => (await db.admin.query(`SELECT * FROM eureka.resume WHERE id = $1`, [id])).rows[0];

/** r1a's own Dallas candidate (team t1), visible to its team only. */
const own = () => candidates.find((c) => c.recruiterId === U.r1a && c.visibility === "team" && c.marketingStatus === "active")!;

describe("differential: RLS alone matches the engine", () => {
  beforeAll(async () => {
    // One clean resume per candidate, written with triggers off (test setup only).
    const c = await db.admin.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL session_replication_role = replica");
      for (const cand of candidates) {
        await c.query(
          `INSERT INTO eureka.resume (candidate_id, status, scan_result, content_type, size_bytes, sha256_hex, version, is_current,
             uploaded_by, upload_expires_at, scanned_at)
           VALUES ($1, 'clean', 'NO_THREATS_FOUND', $2, 10, $3, 100, false, $4, now(), now())`, [cand.id, PDF, SHA, U.hr]);
      }
      await c.query("COMMIT");
    } finally {
      c.release();
    }
  });
  afterAll(async () => {
    const c = await db.admin.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL session_replication_role = replica");
      await c.query("DELETE FROM eureka.resume");
      await c.query("COMMIT");
    } finally {
      c.release();
    }
  });

  it.each(users)("resume rows readable by %s = engine (candidate readable and document:read covers it)", async (key) => {
    const access = toUserAccess(key);
    const expected = candidates
      .filter((c) => candidateVisible(resolveScope(access, "candidate:read"), c) && resumeAccess(access, c).read)
      .map((c) => c.id).sort();
    const actual = await asUser(db.app, access.userId, async (c) =>
      (await c.query<{ candidate_id: string }>(`SELECT candidate_id FROM eureka.resume`)).rows.map((r) => r.candidate_id).sort());
    expect(actual).toEqual(expected);
  });

  /** rule3Probe under every planner variant (statistics refreshed before each, so counts are reproducible). */
  async function probeAll(userId: string, sql: string): Promise<Record<string, Rule3Probe>> {
    const out: Record<string, Rule3Probe> = {};
    for (const [name, planner] of Object.entries(PLANNER_VARIANTS)) out[name] = await rule3Probe(db.admin, userId, sql, { planner });
    return out;
  }

  it.each(["l1", "m1", "r1a", "hr"] as const)(
    "rule 3: authz calls for %s do not grow with the number of resume rows (scope evaluated once per statement)", async (key) => {
      const one = await probeAll(U[key], `SELECT id FROM eureka.resume`);
      // Double the table: a second resume for every candidate.
      const c = await db.admin.connect();
      try {
        await c.query("BEGIN");
        await c.query("SET LOCAL session_replication_role = replica");
        await c.query(`INSERT INTO eureka.resume (candidate_id, status, scan_result, content_type, size_bytes, sha256_hex, version, is_current,
            uploaded_by, upload_expires_at, scanned_at)
          SELECT candidate_id, 'clean', 'NO_THREATS_FOUND', content_type, 10, sha256_hex, 200 + $1::int, false, uploaded_by, now(), now()
          FROM eureka.resume WHERE version = 100`, [Object.keys(U).indexOf(key)]);
        await c.query("COMMIT");
        const two = await probeAll(U[key], `SELECT id FROM eureka.resume`);
        for (const name of Object.keys(PLANNER_VARIANTS)) {
          const [a, b] = [one[name]!, two[name]!];
          expect(b.rows, name).toBe(a.rows * 2);
          expect(a.calls, name).toBeGreaterThan(0);
          expect([...a.perRow, ...b.perRow], name).toEqual([]);
          expect(a.rescannedInitPlans + b.rescannedInitPlans, name).toBe(0);
          expect(b.calls, name).toBe(a.calls);
        }
      } finally {
        c.release();
        const d = await db.admin.connect();
        try {
          await d.query("BEGIN");
          await d.query("SET LOCAL session_replication_role = replica");
          await d.query("DELETE FROM eureka.resume WHERE version > 100");
          await d.query("COMMIT");
        } finally {
          d.release();
        }
      }
    }, 120_000);

  it("sanity: some users see some resumes and some see none", async () => {
    const counts = await Promise.all(users.map((k) =>
      asUser(db.app, U[k], async (c) => (await c.query(`SELECT count(*)::int AS n FROM eureka.resume`)).rows[0].n as number)));
    expect(Math.max(...counts)).toBe(candidates.length); // HR, Accounts, Immigration (org)
    expect(counts[users.indexOf("ceo")]).toBe(0);         // no document:read
    expect(counts[users.indexOf("locD")]).toBe(0);
    expect(counts[users.indexOf("r1a")]).toBeLessThan(counts[users.indexOf("l1")]!); // own vs team
  });
});

describe("authz.create_resume_upload", () => {
  const sample = () => [
    own(),
    candidates.find((c) => c.recruiterId === U.r1b && c.visibility === "team")!,                           // teammate's
    candidates.find((c) => c.teamId !== own().teamId && c.visibility === "all_teams" && c.marketingStatus === "active")!, // other team, open to all
    candidates.find((c) => c.teamId !== own().teamId && c.visibility === "team")!,                          // other team
  ];

  it.each(users)("outcome for %s matches the engine (404 not readable, 403 not covered, else created)", async (key) => {
    const access = toUserAccess(key);
    for (const cand of sample()) {
      const run = createUpload(access.userId, cand.id, 1000, PDF, false);
      if (!candidateVisible(resolveScope(access, "candidate:read"), cand)) await expect(run).rejects.toThrow(/not_found/);
      else if (!resumeAccess(access, cand).upload) await expect(run).rejects.toThrow(/not_permitted/);
      else await expect(run).resolves.toMatchObject({ id: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    }
  });

  it("the server sets status, uploader, timestamps and expiry; bad input and missing user are refused", async () => {
    const before = Date.now();
    const r = await createUpload(U.r1a, own().id, 2048, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    const stored = await row(r.id);
    expect(stored).toMatchObject({ status: "pending", uploaded_by: U.r1a, is_current: false, version: null, sha256_hex: null, scanned_at: null, size_bytes: 2048 });
    const ttl = stored.upload_expires_at.getTime() - stored.created_at.getTime();
    expect(ttl).toBe(5 * 60_000);
    expect(stored.created_at.getTime()).toBeGreaterThanOrEqual(before - 5_000);
    await expect(createUpload(U.r1a, own().id, 1000, "text/html")).rejects.toThrow(/invalid_upload/);
    await expect(createUpload(U.r1a, own().id, 15 * 1024 * 1024 + 1)).rejects.toThrow(/invalid_upload/);
    await expect(createUpload(U.r1a, own().id, 0)).rejects.toThrow(/invalid_upload/);
    await expect(db.app.query(`SELECT * FROM authz.create_resume_upload($1, $2, 10)`, [own().id, PDF])).rejects.toThrow(/not_permitted/);
  });

  it("at most three uploads per candidate wait at once", async () => {
    const cand = candidates.find((c) => c.recruiterId === U.r1a && c.marketingStatus === "on_hold")!;
    for (let i = 0; i < 3; i++) await createUpload(U.r1a, cand.id);
    await expect(createUpload(U.r1a, cand.id)).rejects.toThrow(/too_many_pending/);
  });
});

describe("writes only through definer functions", () => {
  it("the app role cannot insert, update or delete resume rows", async () => {
    const r = await createUpload(U.l1, own().id);
    await expect(asUser(db.app, U.l1, (c) => c.query(
      `INSERT INTO eureka.resume (candidate_id, content_type, size_bytes, uploaded_by, upload_expires_at) VALUES ($1, $2, 10, $3, now())`,
      [own().id, PDF, U.l1]))).rejects.toThrow(/permission denied/);
    await expect(asUser(db.app, U.l1, (c) => c.query(`UPDATE eureka.resume SET status = 'clean' WHERE id = $1`, [r.id]))).rejects.toThrow(/permission denied/);
    await expect(asUser(db.app, U.l1, (c) => c.query(`DELETE FROM eureka.resume WHERE id = $1`, [r.id]))).rejects.toThrow(/permission denied/);
    await expect(asUser(db.app, U.l1, (c) => c.query(`SELECT authz.resume_scan_finish($1, 'clean', 'NO_THREATS_FOUND', $2, 1000)`, [r.id, SHA])))
      .rejects.toThrow(/permission denied/);
    await expect(asUser(db.app, U.l1, (c) => c.query(`SELECT * FROM authz.resume_scan_queue(10)`))).rejects.toThrow(/permission denied/);
  });

  it("the worker cannot create uploads or touch the table directly", async () => {
    await expect(db.worker.query(`SELECT * FROM authz.create_resume_upload($1, $2, 10)`, [own().id, PDF])).rejects.toThrow(/permission denied/);
    await expect(db.worker.query(`SELECT id FROM eureka.resume`)).rejects.toThrow(/permission denied/);
  });

  it("even the owner and superuser cannot write around the guard; no delete or truncate", async () => {
    const r = await createUpload(U.l1, own().id);
    await expect(db.admin.query(`UPDATE eureka.resume SET status = 'clean' WHERE id = $1`, [r.id])).rejects.toThrow(/definer functions/);
    await expect(db.admin.query(`DELETE FROM eureka.resume WHERE id = $1`, [r.id])).rejects.toThrow(/definer functions/);
    await expect(db.admin.query(`TRUNCATE eureka.resume`)).rejects.toThrow(/not truncated/);
  });
});

describe("scan state machine (authz.resume_scan_finish)", () => {
  const cand = () => candidates.find((c) => c.recruiterId === U.r2a && c.marketingStatus === "active" && c.visibility === "team")!;

  it("the queue lists pending uploads, oldest first, with declared metadata only", async () => {
    const r = await createUpload(U.l2, cand().id, 4321);
    const q = (await db.worker.query(`SELECT * FROM authz.resume_scan_queue(100, $1)`, [r.id])).rows;
    expect(q).toEqual([{ id: r.id, content_type: PDF, size_bytes: 4321, created_at: expect.any(Date), upload_expires_at: expect.any(Date) }]);
    expect(await finish(r.id, "failed", "TIMEOUT")).toBe("failed");
    expect((await db.worker.query(`SELECT * FROM authz.resume_scan_queue(100, $1)`, [r.id])).rows).toEqual([]);
  });

  it("clean: next version, current, previous current demoted; one current per candidate", async () => {
    const a = await createUpload(U.l2, cand().id, 1000);
    const b = await createUpload(U.l2, cand().id, 2000);
    expect(await finish(a.id, "clean", "NO_THREATS_FOUND", SHA, 1000)).toBe("clean");
    expect(await row(a.id)).toMatchObject({ status: "clean", version: 1, is_current: true, sha256_hex: SHA, scan_result: "NO_THREATS_FOUND" });
    expect((await row(a.id)).scanned_at).toBeInstanceOf(Date);
    expect(await finish(b.id, "clean", "NO_THREATS_FOUND", "b".repeat(64), 2000)).toBe("clean");
    expect(await row(b.id)).toMatchObject({ version: 2, is_current: true });
    expect(await row(a.id)).toMatchObject({ version: 1, is_current: false });
    const current = (await db.admin.query(`SELECT count(*)::int n FROM eureka.resume WHERE candidate_id = $1 AND is_current`, [cand().id])).rows[0].n;
    expect(current).toBe(1);
  });

  it("clean needs NO_THREATS_FOUND, the declared size and a SHA-256", async () => {
    const r = await createUpload(U.l2, cand().id, 1000);
    await expect(finish(r.id, "clean", "THREATS_FOUND", SHA, 1000)).rejects.toThrow(/invalid_scan_result/);
    await expect(finish(r.id, "clean", "NO_THREATS_FOUND", SHA, 999)).rejects.toThrow(/invalid_scan_result/);
    await expect(finish(r.id, "clean", "NO_THREATS_FOUND", "nope", 1000)).rejects.toThrow(/invalid_scan_result/);
    await expect(finish(r.id, "clean", "NO_THREATS_FOUND", null, 1000)).rejects.toThrow(/invalid_scan_result/);
    await expect(finish(r.id, "pending", "X")).rejects.toThrow(/invalid_scan_result/);
    await expect(finish(r.id, "failed", "free text reason")).rejects.toThrow(/invalid_scan_result/);
    expect(await finish(r.id, "infected", "THREATS_FOUND")).toBe("infected");
    expect(await row(r.id)).toMatchObject({ status: "infected", is_current: false, version: null });
  });

  it("a finished row is final: a second result is ignored and direct changes are refused", async () => {
    const r = await createUpload(U.l2, cand().id, 1000);
    expect(await finish(r.id, "rejected", "BAD_CONTENT")).toBe("rejected");
    expect(await finish(r.id, "clean", "NO_THREATS_FOUND", SHA, 1000)).toBe("not_pending");
    expect((await row(r.id)).status).toBe("rejected");
    const c = await db.admin.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL ROLE authz_definer");
      await expect(c.query(`UPDATE eureka.resume SET status = 'clean', version = 9, sha256_hex = $2 WHERE id = $1`, [r.id, SHA]))
        .rejects.toThrow(/final/);
    } finally {
      await c.query("ROLLBACK");
      c.release();
    }
  });

  it("expired only after the upload window has closed", async () => {
    const r = await createUpload(U.l2, cand().id, 1000);
    await expect(finish(r.id, "expired", "NOT_UPLOADED")).rejects.toThrow(/invalid_scan_result/);
    const c = await db.admin.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL session_replication_role = replica");
      await c.query(`UPDATE eureka.resume SET upload_expires_at = now() - interval '1 minute' WHERE id = $1`, [r.id]);
      await c.query("COMMIT");
    } finally {
      c.release();
    }
    expect(await finish(r.id, "expired", "NOT_UPLOADED")).toBe("expired");
  });
});

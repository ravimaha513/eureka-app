import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DOCUMENT_TYPES, DOCUMENT_TYPE_LIST, candidateVisible, documentAccess, resolveScope } from "@eureka/shared";
import { asUser, createTestDb, type TestDb } from "./db-harness.js";
import { U, seedFixtures, toUserAccess, type FixtureCandidate } from "./fixtures.js";
import { createPlacement, newCandidate, selectedSubmission } from "./placement-seed.js";

/**
 * Database-only checks for migration 0043 (documents, restricted documents,
 * step-up): RLS alone matches the engine, writes only through the definer
 * functions, the scan state machine, step-up challenge/grant binding, expiry
 * and replay, and the access log + audit rows (design B8: rules hold with the
 * API removed).
 */
let db: TestDb;
let candidates: FixtureCandidate[];
const users = Object.keys(U) as (keyof typeof U)[];
const PDF = "application/pdf";
const SHA = "a".repeat(64);
const sha256 = (s: string | Buffer) => createHash("sha256").update(s).digest();

beforeAll(async () => {
  db = await createTestDb();
  candidates = await seedFixtures(db.admin);
}, 120_000);

afterAll(async () => {
  await db?.drop();
});

/** As superuser with triggers off: fixture rows the guards would refuse (test setup only). */
async function raw(sql: string, params: unknown[] = []) {
  const c = await db.admin.connect();
  try {
    await c.query("BEGIN");
    await c.query("SET LOCAL session_replication_role = replica");
    const r = await c.query(sql, params);
    await c.query("COMMIT");
    return r.rows;
  } catch (err) {
    await c.query("ROLLBACK");
    throw err;
  } finally {
    c.release();
  }
}

const upload = (actor: string, candidateId: string | null, docType: string, opts: { placementId?: string | null; size?: number; type?: string; commit?: boolean } = {}) =>
  asUser(db.app, actor, async (c) =>
    (await c.query<{ document_id: string; file_id: string; classification: string; upload_expires_at: Date }>(
      `SELECT * FROM authz.create_document_upload($1, $2, $3, $4, $5)`,
      [candidateId, opts.placementId ?? null, docType, opts.type ?? PDF, opts.size ?? 1000])).rows[0]!, opts.commit ?? true);

const finish = (id: string, status: string, result: string, sha: string | null = null, size: number | null = null) =>
  db.worker.query<{ s: string }>(`SELECT authz.document_scan_finish($1, $2, $3, $4, $5) AS s`, [id, status, result, sha, size]).then((r) => r.rows[0]!.s);

const own = () => candidates.find((c) => c.recruiterId === U.r1a && c.visibility === "team" && c.marketingStatus === "active")!;

/** A live session row for `userId`; returns its hashed id (what the API passes). */
async function session(userId: string, opts: { expiresIn?: string } = {}): Promise<Buffer> {
  const hash = sha256(randomBytes(32));
  await db.admin.query(
    `INSERT INTO eureka.session (id_hash, user_id, expires_at, auth_time, access_version)
     SELECT $1, id, now() + $3::interval, now(), access_version FROM eureka.app_user WHERE id = $2`,
    [hash, userId, opts.expiresIn ?? "1 hour"]);
  return hash;
}

const devGrant = (userId: string, s: Buffer, ttl = 10) =>
  asUser(db.app, userId, async (c) => (await c.query<{ grant_id: string; expires_at: Date }>(`SELECT * FROM authz.step_up_dev($1, $2)`, [s, ttl])).rows[0]!, true);
const current = (userId: string, s: Buffer) =>
  asUser(db.app, userId, async (c) => (await c.query<{ grant_id: string; method: string; expires_at: Date }>(`SELECT * FROM authz.step_up_current($1)`, [s])).rows);
const download = (userId: string, documentId: string, s: Buffer | null) =>
  asUser(db.app, userId, async (c) => (await c.query<{ outcome: string; file_id: string | null; access_id: string | null; classification: string }>(
    `SELECT * FROM authz.document_download($1, $2)`, [documentId, s])).rows[0]!, true);

describe("document types", () => {
  it("authz.document_type equals packages/shared DOCUMENT_TYPES", async () => {
    const rows = (await db.admin.query(`SELECT key, label, classification FROM authz.document_type ORDER BY key`)).rows;
    expect(rows).toEqual(DOCUMENT_TYPE_LIST.map((k) => ({ key: k, ...DOCUMENT_TYPES[k] })).sort((a, b) => a.key.localeCompare(b.key)));
  });

  it("is readable by the app, not writable; types are never removed or reclassified", async () => {
    expect((await asUser(db.app, U.r1a, (c) => c.query(`SELECT count(*)::int n FROM authz.document_type`))).rows[0].n).toBe(DOCUMENT_TYPE_LIST.length);
    await expect(asUser(db.app, U.hr, (c) => c.query(`INSERT INTO authz.document_type VALUES ('x_ray', 'X', 'internal')`))).rejects.toThrow(/permission denied/);
    await expect(db.admin.query(`UPDATE authz.document_type SET classification = 'internal' WHERE key = 'i9'`)).rejects.toThrow(/reclassified/);
    await expect(db.admin.query(`DELETE FROM authz.document_type WHERE key = 'i9'`)).rejects.toThrow(/reclassified/);
  });
});

describe("differential: RLS alone matches the engine", () => {
  beforeAll(async () => {
    // One internal and one restricted clean document per candidate.
    for (const cand of candidates) {
      for (const [type, cls] of [["offer_letter", "internal"], ["i9", "restricted"]] as const) {
        const f = (await raw(`INSERT INTO eureka.file_object (classification, status, scan_result, content_type, size_bytes, sha256_hex, uploaded_by, upload_expires_at, scanned_at)
          VALUES ($1, 'clean', 'NO_THREATS_FOUND', $2, 10, $3, $4, now(), now()) RETURNING id`, [cls, PDF, SHA, U.hr]))[0]!.id as string;
        await raw(`INSERT INTO eureka.document (candidate_id, doc_type, classification, file_id, created_by) VALUES ($1, $2, $3, $4, $5)`,
          [cand.id, type, cls, f, U.hr]);
      }
    }
  });

  it.each(users)("document rows readable by %s = engine (internal: document:read; restricted: + document.restricted:read)", async (key) => {
    const access = toUserAccess(key);
    const readable = candidates.filter((c) => candidateVisible(resolveScope(access, "candidate:read"), c));
    const expected = [
      ...readable.filter((c) => documentAccess(access, c).read).map((c) => `${c.id}:internal`),
      ...readable.filter((c) => documentAccess(access, c).readRestricted).map((c) => `${c.id}:restricted`),
    ].sort();
    const actual = await asUser(db.app, access.userId, async (c) =>
      (await c.query<{ k: string }>(`SELECT candidate_id || ':' || classification AS k FROM eureka.document`)).rows.map((r) => r.k).sort());
    expect(actual).toEqual(expected);
    // A file is visible exactly with its document.
    const files = await asUser(db.app, access.userId, async (c) =>
      (await c.query(`SELECT count(*)::int n FROM eureka.file_object WHERE id IN (SELECT file_id FROM eureka.document)`)).rows[0].n as number);
    const allFiles = await asUser(db.app, access.userId, async (c) => (await c.query(`SELECT count(*)::int n FROM eureka.file_object`)).rows[0].n as number);
    expect(files).toBe(expected.length);
    expect(allFiles).toBe(expected.length);
  });

  it("only HR, Accounts and Immigration see restricted documents (every fixture user)", async () => {
    const seeing = [];
    for (const key of users) {
      const n = await asUser(db.app, U[key], async (c) =>
        (await c.query(`SELECT count(*)::int n FROM eureka.document WHERE classification = 'restricted'`)).rows[0].n as number);
      if (n > 0) seeing.push(key);
    }
    expect(seeing.sort()).toEqual(["acct", "hr", "imm"]);
  });

  /** Calls of every authz.* function while `sql` runs as eureka_app for `userId`. */
  async function authzCalls(userId: string, sql: string): Promise<{ calls: number; rows: number }> {
    const c = await db.admin.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL track_functions = 'all'");
      await c.query("SELECT set_config('eureka.user_id', $1, true)", [userId]);
      const count = async () => Number((await c.query<{ n: string }>(
        `SELECT coalesce(sum(pg_stat_get_xact_function_calls(p.oid)), 0)::bigint AS n
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'authz'`)).rows[0]!.n);
      const before = await count();
      await c.query("SET LOCAL ROLE eureka_app");
      const rows = (await c.query(sql)).rowCount ?? 0;
      await c.query("RESET ROLE");
      return { calls: (await count()) - before, rows };
    } finally {
      await c.query("ROLLBACK").catch(() => undefined);
      c.release();
    }
  }

  it.each(["l1", "r1a", "hr", "acct"] as const)("rule 3: authz calls for %s do not grow with the number of document rows", async (key) => {
    const sql = `SELECT d.id FROM eureka.document d JOIN eureka.file_object f ON f.id = d.file_id`;
    const one = await authzCalls(U[key], sql);
    const extra = await raw(`WITH f AS (
        INSERT INTO eureka.file_object (classification, status, scan_result, content_type, size_bytes, sha256_hex, uploaded_by, upload_expires_at, scanned_at)
        SELECT classification, 'clean', 'NO_THREATS_FOUND', content_type, 11, sha256_hex, uploaded_by, now(), now() FROM eureka.file_object WHERE size_bytes = 10
        RETURNING id, classification)
      SELECT id, classification FROM f`);
    try {
      const byCls = { internal: [] as string[], restricted: [] as string[] };
      for (const r of extra) byCls[r.classification as "internal" | "restricted"].push(r.id);
      const docs = (await db.admin.query(`SELECT candidate_id, classification FROM eureka.document ORDER BY candidate_id, classification`)).rows;
      for (const d of docs.filter((x) => x.classification === "internal")) {
        await raw(`INSERT INTO eureka.document (candidate_id, doc_type, classification, file_id, created_by) VALUES ($1, 'other', 'internal', $2, $3)`,
          [d.candidate_id, byCls.internal.pop(), U.hr]);
      }
      for (const d of docs.filter((x) => x.classification === "restricted")) {
        await raw(`INSERT INTO eureka.document (candidate_id, doc_type, classification, file_id, created_by) VALUES ($1, 'drivers_license', 'restricted', $2, $3)`,
          [d.candidate_id, byCls.restricted.pop(), U.hr]);
      }
      const two = await authzCalls(U[key], sql);
      expect(two.rows).toBe(one.rows * 2);
      expect(one.calls).toBeGreaterThan(0);
      expect(two.calls).toBe(one.calls);
    } finally {
      await raw(`DELETE FROM eureka.document WHERE file_id IN (SELECT id FROM eureka.file_object WHERE size_bytes = 11)`);
      await raw(`DELETE FROM eureka.file_object WHERE size_bytes = 11`);
    }
  });

  afterAll(async () => {
    await raw(`DELETE FROM eureka.document`);
    await raw(`DELETE FROM eureka.file_object`);
  });
});

describe("authz.create_document_upload", () => {
  const sample = () => [
    own(),
    candidates.find((c) => c.recruiterId === U.r1b && c.visibility === "team")!,
    candidates.find((c) => c.teamId !== own().teamId && c.visibility === "all_teams" && c.marketingStatus === "active")!,
    candidates.find((c) => c.teamId !== own().teamId && c.visibility === "team")!,
  ];

  it.each(users)("outcome for %s matches the engine, internal and restricted types", async (key) => {
    const access = toUserAccess(key);
    for (const cand of sample()) {
      for (const type of ["offer_letter", "i9"] as const) {
        const run = upload(access.userId, cand.id, type, { commit: false });
        const a = documentAccess(access, cand);
        if (!candidateVisible(resolveScope(access, "candidate:read"), cand)) await expect(run).rejects.toThrow(/not_found/);
        else if (!(type === "i9" ? a.uploadRestricted : a.upload)) await expect(run).rejects.toThrow(/not_permitted/);
        else await expect(run).resolves.toMatchObject({ classification: DOCUMENT_TYPES[type].classification });
      }
    }
  });

  it("the server sets status, uploader, timestamps, expiry and the classification; the upload is audited without names", async () => {
    const r = await upload(U.hr, own().id, "work_authorization", { size: 2048, type: "image/png" });
    const f = (await db.admin.query(`SELECT * FROM eureka.file_object WHERE id = $1`, [r.file_id])).rows[0];
    expect(f).toMatchObject({ status: "pending", uploaded_by: U.hr, classification: "restricted", sha256_hex: null, scanned_at: null, size_bytes: 2048, content_type: "image/png" });
    expect(f.upload_expires_at.getTime() - f.created_at.getTime()).toBe(5 * 60_000);
    const d = (await db.admin.query(`SELECT * FROM eureka.document WHERE id = $1`, [r.document_id])).rows[0];
    expect(d).toMatchObject({ candidate_id: own().id, placement_id: null, doc_type: "work_authorization", classification: "restricted", file_id: r.file_id, created_by: U.hr });
    const audit = (await db.admin.query(`SELECT actor_id, action, entity_type, entity_id, changes FROM eureka.audit_event WHERE entity_id = $1`, [r.document_id])).rows;
    expect(audit).toEqual([{ actor_id: U.hr, action: "document.upload_requested", entity_type: "document", entity_id: r.document_id, changes: {
      candidateId: own().id, placementId: null, fileId: r.file_id, docType: "work_authorization", classification: "restricted",
      contentType: "image/png", sizeBytes: 2048 } }]);
  });

  it("refuses unknown types, types outside the allowlist, bad sizes, both or neither owner, and a missing user", async () => {
    await expect(upload(U.hr, own().id, "passport_scan")).rejects.toThrow(/invalid_upload/);
    await expect(upload(U.hr, own().id, "i9", { type: "text/html" })).rejects.toThrow(/invalid_upload/);
    await expect(upload(U.hr, own().id, "i9", { type: "image/gif" })).rejects.toThrow(/invalid_upload/);
    await expect(upload(U.hr, own().id, "i9", { size: 15 * 1024 * 1024 + 1 })).rejects.toThrow(/invalid_upload/);
    await expect(upload(U.hr, own().id, "i9", { size: 0 })).rejects.toThrow(/invalid_upload/);
    await expect(upload(U.hr, null, "i9")).rejects.toThrow(/invalid_upload/);
    await expect(upload(U.hr, own().id, "i9", { placementId: own().id })).rejects.toThrow(/invalid_upload/);
    await expect(db.app.query(`SELECT * FROM authz.create_document_upload($1, NULL, 'i9', $2, 10)`, [own().id, PDF])).rejects.toThrow(/not_permitted/);
  });

  it("at most five uploads per candidate wait at once", async () => {
    const cand = candidates.find((c) => c.recruiterId === U.r1a && c.marketingStatus === "on_hold")!;
    for (let i = 0; i < 5; i++) await upload(U.r1a, cand.id, "other");
    await expect(upload(U.r1a, cand.id, "offer_letter")).rejects.toThrow(/too_many_pending/);
  });

  it("placement documents: the placement must be readable; the candidate comes from the placement", async () => {
    const cand = await newCandidate(db, { teamId: own().teamId, recruiterId: U.r1a, locationId: own().locationId });
    const placement = (await createPlacement(db, U.r1a, await selectedSubmission(db, U.r1a, cand.id))).id;
    const r = await upload(U.hr, null, "i9", { placementId: placement });
    expect((await db.admin.query(`SELECT candidate_id, placement_id FROM eureka.document WHERE id = $1`, [r.document_id])).rows[0])
      .toEqual({ candidate_id: cand.id, placement_id: placement });
    // r1a reads the placement and uploads internal paperwork; r2a cannot see it.
    await expect(upload(U.r1a, null, "offer_letter", { placementId: placement })).resolves.toMatchObject({ classification: "internal" });
    await expect(upload(U.r2a, null, "offer_letter", { placementId: placement, commit: false })).rejects.toThrow(/not_found/);
    // Immigration has no placement:read: placement route 404, the candidate route works.
    await expect(upload(U.imm, null, "i9", { placementId: placement, commit: false })).rejects.toThrow(/not_found/);
    await expect(upload(U.imm, cand.id, "i9", { commit: false })).resolves.toMatchObject({ classification: "restricted" });
    await expect(upload(U.hr, null, "i9", { placementId: "00000000-0000-4000-8000-000000000000", commit: false })).rejects.toThrow(/not_found/);
  });
});

describe("writes only through definer functions", () => {
  it("the app role cannot write documents, files, the access log or step-up rows", async () => {
    const r = await upload(U.l1, own().id, "other");
    const deny = (sql: string, params: unknown[] = []) => expect(asUser(db.app, U.hr, (c) => c.query(sql, params))).rejects.toThrow(/permission denied/);
    await deny(`INSERT INTO eureka.file_object (classification, content_type, size_bytes, uploaded_by, upload_expires_at) VALUES ('internal', $1, 10, $2, now())`, [PDF, U.hr]);
    await deny(`UPDATE eureka.file_object SET status = 'clean' WHERE id = $1`, [r.file_id]);
    await deny(`UPDATE eureka.document SET classification = 'internal' WHERE id = $1`, [r.document_id]);
    await deny(`DELETE FROM eureka.document WHERE id = $1`, [r.document_id]);
    await deny(`INSERT INTO eureka.document_access (document_id, user_id, action, doc_type, classification) VALUES ($1, $2, 'download', 'other', 'internal')`, [r.document_id, U.hr]);
    await deny(`SELECT * FROM eureka.step_up_grant`);
    await deny(`SELECT * FROM eureka.step_up_challenge`);
    await deny(`INSERT INTO eureka.step_up_grant (session_hash, user_id, method, auth_time, expires_at) VALUES ($1, $2, 'dev', now(), now() + interval '5 minutes')`, [Buffer.alloc(32), U.hr]);
    await deny(`SELECT authz.document_scan_finish($1, 'clean', 'NO_THREATS_FOUND', $2, 1000)`, [r.file_id, SHA]);
    await deny(`SELECT * FROM authz.document_scan_queue(10)`);
    await deny(`SELECT authz.session_is_mine($1)`, [Buffer.alloc(32)]);
  });

  it("the worker cannot create uploads, read documents or grant step-up", async () => {
    await expect(db.worker.query(`SELECT * FROM authz.create_document_upload($1, NULL, 'other', $2, 10)`, [own().id, PDF])).rejects.toThrow(/permission denied/);
    await expect(db.worker.query(`SELECT id FROM eureka.document`)).rejects.toThrow(/permission denied/);
    await expect(db.worker.query(`SELECT * FROM authz.step_up_dev($1, 10)`, [Buffer.alloc(32)])).rejects.toThrow(/permission denied/);
    await expect(db.worker.query(`SELECT * FROM authz.document_download($1, NULL)`, [own().id])).rejects.toThrow(/permission denied/);
  });

  it("even the owner and superuser cannot write around the guards; no delete or truncate of the log", async () => {
    const r = await upload(U.l1, own().id, "other");
    await expect(db.admin.query(`UPDATE eureka.file_object SET status = 'clean' WHERE id = $1`, [r.file_id])).rejects.toThrow(/definer functions/);
    await expect(db.admin.query(`DELETE FROM eureka.document WHERE id = $1`, [r.document_id])).rejects.toThrow(/definer functions/);
    await expect(db.admin.query(`TRUNCATE eureka.document_access`)).rejects.toThrow(/append-only/);
    await expect(db.admin.query(`TRUNCATE eureka.document, eureka.file_object CASCADE`)).rejects.toThrow(/append-only/);
    const c = await db.admin.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL ROLE authz_definer");
      // A document cannot claim a type whose classification differs from its file's.
      const f = (await c.query(`SELECT id FROM eureka.file_object WHERE id = $1`, [r.file_id])).rows[0].id;
      await expect(c.query(`INSERT INTO eureka.document (candidate_id, doc_type, classification, file_id, created_by) VALUES ($1, 'i9', 'internal', $2, $3)`,
        [own().id, f, U.hr])).rejects.toThrow(/do not match/);
    } finally {
      await c.query("ROLLBACK");
      c.release();
    }
  });
});

describe("scan state machine (authz.document_scan_finish)", () => {
  it("queue lists pending files with declared metadata; clean needs NO_THREATS_FOUND, the size and a SHA-256; results are final", async () => {
    const r = await upload(U.hr, own().id, "i9", { size: 4321 });
    expect((await db.worker.query(`SELECT * FROM authz.document_scan_queue(100, $1)`, [r.file_id])).rows).toEqual([{
      id: r.file_id, classification: "restricted", content_type: PDF, size_bytes: 4321, created_at: expect.any(Date), upload_expires_at: expect.any(Date) }]);
    await expect(finish(r.file_id, "clean", "THREATS_FOUND", SHA, 4321)).rejects.toThrow(/invalid_scan_result/);
    await expect(finish(r.file_id, "clean", "NO_THREATS_FOUND", SHA, 4320)).rejects.toThrow(/invalid_scan_result/);
    await expect(finish(r.file_id, "clean", "NO_THREATS_FOUND", null, 4321)).rejects.toThrow(/invalid_scan_result/);
    await expect(finish(r.file_id, "failed", "free text")).rejects.toThrow(/invalid_scan_result/);
    await expect(finish(r.file_id, "expired", "NOT_UPLOADED")).rejects.toThrow(/invalid_scan_result/);
    expect(await finish(r.file_id, "clean", "NO_THREATS_FOUND", SHA, 4321)).toBe("clean");
    expect(await finish(r.file_id, "infected", "THREATS_FOUND")).toBe("not_pending");
    expect((await db.admin.query(`SELECT status, sha256_hex FROM eureka.file_object WHERE id = $1`, [r.file_id])).rows[0]).toEqual({ status: "clean", sha256_hex: SHA });
    expect((await db.worker.query(`SELECT * FROM authz.document_scan_queue(100, $1)`, [r.file_id])).rows).toEqual([]);
  });
});

describe("step-up (authz.step_up_*)", () => {
  const state = () => randomBytes(32);
  const begin = (userId: string, s: Buffer, st: Buffer, nonce: Buffer, returnTo = "/candidates") =>
    asUser(db.app, userId, (c) => c.query(`SELECT authz.step_up_begin($1, $2, $3, $4) AS e`, [s, sha256(st), sha256(nonce), returnTo]), true);
  const complete = (userId: string, s: Buffer, st: Buffer, nonce: Buffer, sub: string | null, authTime: Date | null, maxAge = 300, ttl = 10) =>
    asUser(db.app, userId, async (c) => (await c.query<{ outcome: string; grant_id: string | null; expires_at: Date | null; return_to: string | null }>(
      `SELECT * FROM authz.step_up_complete($1, $2, $3, $4, $5, $6, $7)`, [s, sha256(st), sha256(nonce), sub, authTime, maxAge, ttl])).rows[0]!, true);

  beforeAll(async () => {
    await db.admin.query(`UPDATE eureka.app_user SET google_sub = 'sub-' || id::text WHERE id = ANY($1)`, [[U.hr, U.acct, U.imm, U.r1a]]);
  });

  it("a fresh Google sign-in for the linked account grants step-up for this session only, for the TTL", async () => {
    const s = await session(U.hr);
    const other = await session(U.hr);
    const st = state(); const nonce = randomBytes(16);
    await begin(U.hr, s, st, nonce, "/candidates/x?tab=documents");
    const r = await complete(U.hr, s, st, nonce, `sub-${U.hr}`, new Date());
    expect(r).toMatchObject({ outcome: "granted", grant_id: expect.any(String), return_to: "/candidates/x?tab=documents" });
    expect(r.expires_at!.getTime() - Date.now()).toBeGreaterThan(9 * 60_000);
    expect(r.expires_at!.getTime() - Date.now()).toBeLessThanOrEqual(10 * 60_000 + 1000);
    expect(await current(U.hr, s)).toEqual([{ grant_id: r.grant_id, method: "google", auth_time: expect.any(Date), expires_at: r.expires_at }]);
    // Bound to the session: the same user's other session, or another user presenting this session's hash, has none.
    expect(await current(U.hr, other)).toEqual([]);
    expect(await current(U.acct, s)).toEqual([]);
    const audit = (await db.admin.query(`SELECT changes FROM eureka.audit_event WHERE action = 'auth.step_up' AND changes ->> 'grantId' = $1`, [r.grant_id])).rows;
    expect(audit).toEqual([{ changes: { method: "google", grantId: r.grant_id, expiresAt: expect.any(String) } }]);
  });

  it("the challenge is single use: a replayed callback is refused and audited", async () => {
    const s = await session(U.hr);
    const st = state(); const nonce = randomBytes(16);
    await begin(U.hr, s, st, nonce);
    expect((await complete(U.hr, s, st, nonce, `sub-${U.hr}`, new Date())).outcome).toBe("granted");
    expect(await complete(U.hr, s, st, nonce, `sub-${U.hr}`, new Date())).toMatchObject({ outcome: "replayed", grant_id: null });
    // A failed attempt consumes the challenge too.
    const st2 = state();
    await begin(U.hr, s, st2, nonce);
    expect((await complete(U.hr, s, st2, randomBytes(16), `sub-${U.hr}`, new Date())).outcome).toBe("nonce_mismatch");
    expect((await complete(U.hr, s, st2, nonce, `sub-${U.hr}`, new Date())).outcome).toBe("replayed");
    const reasons = (await db.admin.query(`SELECT changes ->> 'reason' r FROM eureka.audit_event WHERE action = 'auth.step_up_failed' AND actor_id = $1 ORDER BY seq`, [U.hr])).rows.map((x) => x.r);
    expect(reasons.slice(-3)).toEqual(["replayed", "nonce_mismatch", "replayed"]);
  });

  type Bad = [string, (u: string) => string | null, () => Date | null, string];
  it.each<Bad>([
    ["another Google account", () => `sub-${U.acct}`, () => new Date(), "wrong_account"],
    ["no sub", () => null, () => new Date(), "wrong_account"],
    ["no auth_time", (u) => `sub-${u}`, () => null, "stale_auth"],
    ["auth_time before the challenge (no re-authentication)", (u) => `sub-${u}`, () => new Date(Date.now() - 5 * 60_000), "stale_auth"],
    ["auth_time in the future", (u) => `sub-${u}`, () => new Date(Date.now() + 5 * 60_000), "stale_auth"],
  ])("refuses %s", async (_n, sub, authTime, outcome) => {
    const s = await session(U.hr);
    const st = state(); const nonce = randomBytes(16);
    await begin(U.hr, s, st, nonce);
    expect(await complete(U.hr, s, st, nonce, sub(U.hr), authTime())).toMatchObject({ outcome, grant_id: null });
    expect(await current(U.hr, s)).toEqual([]);
  });

  it("max_age: auth_time older than the allowed age is refused even after the challenge", async () => {
    const s = await session(U.hr);
    const st = state(); const nonce = randomBytes(16);
    await begin(U.hr, s, st, nonce);
    await raw(`UPDATE eureka.step_up_challenge SET created_at = created_at - interval '2 minutes' WHERE state_hash = $1`, [sha256(st)]);
    expect((await complete(U.hr, s, st, nonce, `sub-${U.hr}`, new Date(Date.now() - 90_000), 60)).outcome).toBe("stale_auth");
  });

  it("refuses an expired challenge, another session's or user's challenge, and a revoked session", async () => {
    const s = await session(U.hr);
    const st = state(); const nonce = randomBytes(16);
    await begin(U.hr, s, st, nonce);
    const otherSession = await session(U.hr);
    expect((await complete(U.hr, otherSession, st, nonce, `sub-${U.hr}`, new Date())).outcome).toBe("unknown_state");
    const acct = await session(U.acct);
    expect((await complete(U.acct, acct, st, nonce, `sub-${U.acct}`, new Date())).outcome).toBe("unknown_state");
    await expect(complete(U.acct, s, st, nonce, `sub-${U.hr}`, new Date())).rejects.toThrow(/not_permitted/);
    await raw(`UPDATE eureka.step_up_challenge SET expires_at = now() - interval '1 second' WHERE state_hash = $1`, [sha256(st)]);
    expect((await complete(U.hr, s, st, nonce, `sub-${U.hr}`, new Date())).outcome).toBe("expired");

    const s2 = await session(U.hr);
    const st2 = state();
    await begin(U.hr, s2, st2, nonce);
    await db.admin.query(`UPDATE eureka.session SET revoked_at = now() WHERE id_hash = $1`, [s2]);
    await expect(complete(U.hr, s2, st2, nonce, `sub-${U.hr}`, new Date())).rejects.toThrow(/not_permitted/);
    await expect(begin(U.hr, s2, state(), nonce)).rejects.toThrow(/not_permitted/);
  });

  it("begin: own live session only, same-origin return path, at most ten per session in ten minutes", async () => {
    const s = await session(U.imm);
    await expect(begin(U.acct, s, state(), randomBytes(16))).rejects.toThrow(/not_permitted/);
    await expect(begin(U.imm, s, state(), randomBytes(16), "https://evil.example/")).rejects.toThrow(/check constraint/);
    await expect(begin(U.imm, s, state(), randomBytes(16), "//evil.example/")).rejects.toThrow(/check constraint/);
    await expect(begin(U.imm, s, state(), randomBytes(16), "/a\\b")).rejects.toThrow(/check constraint/);
    for (let i = 0; i < 10; i++) await begin(U.imm, s, state(), randomBytes(16));
    await expect(begin(U.imm, s, state(), randomBytes(16))).rejects.toThrow(/too_many_step_ups/);
  });

  it("grants expire, die with a revoked or expired session, and the TTL is capped at 15 minutes", async () => {
    await db.admin.query(`INSERT INTO authz.policy_setting (key, value) VALUES ('dev_step_up', 'on') ON CONFLICT (key) DO UPDATE SET value = 'on'`);
    const s = await session(U.acct);
    const g = await devGrant(U.acct, s, 60);
    expect(g.expires_at.getTime() - Date.now()).toBeLessThanOrEqual(15 * 60_000 + 1000);
    expect(await current(U.acct, s)).toHaveLength(1);
    await raw(`UPDATE eureka.step_up_grant SET created_at = now() - interval '11 minutes', expires_at = now() - interval '1 second' WHERE id = $1`, [g.grant_id]);
    expect(await current(U.acct, s)).toEqual([]);

    const s2 = await session(U.acct);
    await devGrant(U.acct, s2);
    await db.admin.query(`UPDATE eureka.session SET revoked_at = now() WHERE id_hash = $1`, [s2]);
    expect(await current(U.acct, s2)).toEqual([]);
    const s3 = await session(U.acct);
    await devGrant(U.acct, s3);
    await db.admin.query(`UPDATE eureka.session SET expires_at = now() - interval '1 second' WHERE id_hash = $1`, [s3]);
    expect(await current(U.acct, s3)).toEqual([]);
    // Grants are append-only even for the definer.
    const c = await db.admin.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL ROLE authz_definer");
      await expect(c.query(`UPDATE eureka.step_up_grant SET expires_at = now() + interval '10 minutes' WHERE id = $1`, [g.grant_id])).rejects.toThrow(/permission denied|append-only/);
    } finally {
      await c.query("ROLLBACK");
      c.release();
    }
  });

  it("dev step-up is refused unless dev_step_up = 'on' (no migration sets it)", async () => {
    await db.admin.query(`DELETE FROM authz.policy_setting WHERE key = 'dev_step_up'`);
    const s = await session(U.hr);
    await expect(devGrant(U.hr, s)).rejects.toThrow(/not_permitted/);
    await db.admin.query(`INSERT INTO authz.policy_setting (key, value) VALUES ('dev_step_up', 'off')`);
    await expect(devGrant(U.hr, s)).rejects.toThrow(/not_permitted/);
    await expect(db.admin.query(`UPDATE authz.policy_setting SET value = 'yes' WHERE key = 'dev_step_up'`)).rejects.toThrow(/check constraint/);
    await db.admin.query(`UPDATE authz.policy_setting SET value = 'on' WHERE key = 'dev_step_up'`);
    await expect(devGrant(U.hr, s)).resolves.toMatchObject({ grant_id: expect.any(String) });
    await expect(devGrant(U.hr, await session(U.acct))).rejects.toThrow(/not_permitted/);
  });
});

describe("authz.document_download: restricted access matrix, access log and audit", () => {
  let restricted: string;
  let internal: string;
  let pending: string;

  beforeAll(async () => {
    await db.admin.query(`INSERT INTO authz.policy_setting (key, value) VALUES ('dev_step_up', 'on') ON CONFLICT (key) DO UPDATE SET value = 'on'`);
    const a = await upload(U.hr, own().id, "i9");
    await finish(a.file_id, "clean", "NO_THREATS_FOUND", SHA, 1000);
    restricted = a.document_id;
    const b = await upload(U.r1a, own().id, "offer_letter");
    await finish(b.file_id, "clean", "NO_THREATS_FOUND", SHA, 1000);
    internal = b.document_id;
    pending = (await upload(U.hr, own().id, "drivers_license")).document_id;
  });

  it.each(users)("%s: restricted needs document.restricted:read and a live step-up of this session", async (key) => {
    const access = toUserAccess(key);
    const a = documentAccess(access, own());
    const readable = candidateVisible(resolveScope(access, "candidate:read"), own());
    const s = await session(U[key]);
    if (!readable || !a.readRestricted) {
      await expect(download(U[key], restricted, s)).rejects.toThrow(/not_found/);
      await expect(devGrant(U[key], s).then(() => download(U[key], restricted, s))).rejects.toThrow(/not_found/);
    } else {
      expect(await download(U[key], restricted, s)).toMatchObject({ outcome: "step_up_required", file_id: null, access_id: null });
      expect(await download(U[key], restricted, null)).toMatchObject({ outcome: "step_up_required" });
      await devGrant(U[key], s);
      expect(await download(U[key], restricted, s)).toMatchObject({ outcome: "ok", file_id: expect.any(String), access_id: expect.any(String), classification: "restricted" });
      // Another session of the same user has no step-up.
      expect(await download(U[key], restricted, await session(U[key]))).toMatchObject({ outcome: "step_up_required" });
    }
    // Internal documents: document:read over the candidate, no step-up.
    if (!readable || !a.read) await expect(download(U[key], internal, null)).rejects.toThrow(/not_found/);
    else expect(await download(U[key], internal, null)).toMatchObject({ outcome: "ok", classification: "internal" });
  });

  it("an expired step-up no longer opens restricted documents", async () => {
    const s = await session(U.imm);
    const g = await devGrant(U.imm, s);
    expect((await download(U.imm, restricted, s)).outcome).toBe("ok");
    await raw(`UPDATE eureka.step_up_grant SET created_at = now() - interval '11 minutes', expires_at = now() - interval '1 second' WHERE id = $1`, [g.grant_id]);
    expect((await download(U.imm, restricted, s)).outcome).toBe("step_up_required");
  });

  it("a file that is not clean is not available (nothing logged)", async () => {
    const s = await session(U.hr);
    await devGrant(U.hr, s);
    const before = (await db.admin.query(`SELECT count(*)::int n FROM eureka.document_access`)).rows[0].n;
    expect((await download(U.hr, pending, s)).outcome).toBe("not_available");
    expect((await db.admin.query(`SELECT count(*)::int n FROM eureka.document_access`)).rows[0].n).toBe(before);
  });

  it("each view writes one access-log row and one audit row with ids and codes only (no names, emails, keys)", async () => {
    const s = await session(U.acct);
    const g = await devGrant(U.acct, s);
    const r = await download(U.acct, restricted, s);
    const log = (await db.admin.query(`SELECT * FROM eureka.document_access WHERE id = $1`, [r.access_id])).rows;
    expect(log).toEqual([{ id: r.access_id, document_id: restricted, user_id: U.acct, action: "download", doc_type: "i9",
      classification: "restricted", step_up_grant_id: g.grant_id, at: expect.any(Date) }]);
    const audit = (await db.admin.query(`SELECT actor_id, action, entity_type, entity_id, changes FROM eureka.audit_event WHERE changes ->> 'accessId' = $1`, [r.access_id])).rows;
    expect(audit).toEqual([{ actor_id: U.acct, action: "document.viewed", entity_type: "document", entity_id: restricted, changes: {
      candidateId: own().id, placementId: null, fileId: r.file_id, docType: "i9", classification: "restricted", accessId: r.access_id, stepUpGrantId: g.grant_id } }]);
    // No PII anywhere in the document and step-up audit rows.
    const rows = (await db.admin.query(`SELECT changes::text t FROM eureka.audit_event WHERE action LIKE 'document.%' OR action LIKE 'auth.step_up%'`)).rows;
    expect(rows.length).toBeGreaterThan(10);
    for (const { t } of rows) {
      expect(t).not.toMatch(/@|Cand\d|Test|\+1469|quarantine\/|clean\/|restricted\/|\.pdf/);
    }
    // The refusal is audited too.
    const refused = (await db.admin.query(`SELECT count(*)::int n FROM eureka.audit_event WHERE action = 'document.view_refused' AND entity_id = $1`, [restricted])).rows[0].n;
    expect(refused).toBeGreaterThan(0);
  });

  it("the access log: org admins (audit:read) see all rows; restricted readers see restricted documents' rows; others none", async () => {
    const total = (await db.admin.query(`SELECT count(*)::int n FROM eureka.document_access`)).rows[0].n as number;
    const restrictedRows = (await db.admin.query(`SELECT count(*)::int n FROM eureka.document_access WHERE classification = 'restricted'`)).rows[0].n as number;
    expect(restrictedRows).toBeGreaterThan(0);
    expect(total).toBeGreaterThan(restrictedRows);
    for (const key of users) {
      const n = await asUser(db.app, U[key], async (c) => (await c.query(`SELECT count(*)::int n FROM eureka.document_access`)).rows[0].n as number);
      const expected = ["admin", "admin2"].includes(key) ? total : ["hr", "acct", "imm"].includes(key) ? restrictedRows : 0;
      expect(n, key).toBe(expected);
    }
  });

  it("the access log cannot be changed or deleted, by the definer or the superuser", async () => {
    await expect(db.admin.query(`DELETE FROM eureka.document_access`)).rejects.toThrow(/append-only/);
    await expect(db.admin.query(`UPDATE eureka.document_access SET user_id = $1`, [U.hr])).rejects.toThrow(/definer functions|append-only/);
  });
});

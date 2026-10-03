import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { can, candidateVisible, documentAccess, resolveScope } from "@eureka/shared";
import { createApp } from "../src/app.module.js";
import { loadConfig } from "../src/platform/config.js";
import { OidcService } from "../src/platform/oidc.service.js";
import { EICAR_TEST_STRING } from "../src/platform/storage/local-files.js";
import { LocalDocumentStore } from "../src/worker/document-store.js";
import { documentScanJob } from "../src/worker/jobs/document-scan.js";
import { DEFAULT_SCAN_OPTIONS } from "../src/worker/jobs/scan-pipeline.js";
import { exportAuditDay } from "../src/worker/jobs/audit-export.js";
import { silentLogger } from "../src/worker/log.js";
import { JobRunner } from "../src/worker/runner.js";
import { DirSink } from "../src/worker/sink.js";
import { createTestDb, type TestDb } from "./db-harness.js";
import { U, seedFixtures, toUserAccess, type FixtureCandidate } from "./fixtures.js";
import { tinyJpeg, tinyPng } from "./images.js";
import { createPlacement, extraUser, newCandidate, selectedSubmission } from "./placement-seed.js";

/**
 * Paperwork and restricted documents end to end (FR-PPR-01 to 03) on the
 * local document driver and the fake scanner: presigned upload -> quarantine
 * -> document-scan -> clean/ or restricted/ -> download; the restricted access
 * matrix with and without step-up (every fixture user), expired step-up, the
 * access log and the audit export (ids only), and Google step-up (OIDC
 * max_age/auth_time) against a local key set (design A6.1, A6.3, A6.5, B8).
 */
let db: TestDb;
let app: NestFastifyApplication;
let dir: string;
let candidates: FixtureCandidate[];
const users = Object.keys(U) as (keyof typeof U)[];
const PDF = "application/pdf";
const adminUrl = new URL(process.env.TEST_PG_ADMIN_URL ?? "postgres://postgres:postgres@127.0.0.1:5432");
const SECRET = "test-secret-test-secret-test-secret-123";

beforeAll(async () => {
  db = await createTestDb();
  candidates = await seedFixtures(db.admin);
  // Dev step-up is a database switch too (no migration sets it).
  await db.admin.query(`INSERT INTO authz.policy_setting (key, value) VALUES ('dev_step_up', 'on')`);
  dir = await mkdtemp(join(tmpdir(), "eureka-docs-"));
  app = await createApp(loadConfig({
    NODE_ENV: "test", AUTH_MODE: "dev", SESSION_SECRET: SECRET,
    DATABASE_URL: `postgres://eureka_app:eureka_app_test@${adminUrl.host}/${db.name}`, LOCAL_STORAGE_DIR: dir,
  }));
}, 120_000);

afterAll(async () => {
  await app?.close();
  await db?.drop();
  if (dir) await rm(dir, { recursive: true, force: true });
});

type Session = { cookie: string; csrf: string };
const sessions = new Map<string, Session>();
async function login(email: string, fresh = false): Promise<Session> {
  const cached = sessions.get(email);
  if (cached && !fresh) return cached;
  const res = await app.inject({ method: "POST", url: "/api/auth/dev-login", payload: { email } });
  expect(res.statusCode).toBe(204);
  const cookie = String(res.headers["set-cookie"]).split(";")[0]!;
  const me = await app.inject({ method: "GET", url: "/api/v1/me", headers: { cookie } });
  const s = { cookie, csrf: me.json().csrfToken as string };
  if (!fresh) sessions.set(email, s);
  return s;
}
const emailOf = (key: string) => `${key}@eureka.example`;
async function call(who: string | Session, method: "GET" | "POST", url: string, payload?: unknown) {
  const s = typeof who === "string" ? await login(emailOf(who)) : who;
  return app.inject({ method, url, payload: payload as never, headers: { cookie: s.cookie, ...(method !== "GET" ? { "x-csrf-token": s.csrf } : {}) } });
}

function form(fields: Record<string, string>, file: Buffer, fileName = "Jane_Doe_I9.pdf") {
  const b = "----eurekaDocsBoundary";
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  parts.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: application/octet-stream\r\n\r\n`), file, Buffer.from(`\r\n--${b}--\r\n`));
  return { payload: Buffer.concat(parts), headers: { "content-type": `multipart/form-data; boundary=${b}` } };
}
const pdf = (text = "hello") => Buffer.from(`%PDF-1.7\n% fictional paperwork ${text}\n%%EOF\n`);
const runScan = async () => {
  await new JobRunner(db.worker, [documentScanJob(new LocalDocumentStore(dir), DEFAULT_SCAN_OPTIONS)], silentLogger).tick();
};
const exists = (p: string) => stat(p).then(() => true, () => false);

type Ticket = { url: string; fields: Record<string, string>; expiresAt: string };
async function upload(who: string, path: string, docType: string, body: Buffer | null, contentType = PDF) {
  const r = await call(who, "POST", path, { docType, contentType, size: body?.length ?? 100 });
  expect(r.statusCode, r.body).toBe(201);
  const out = r.json() as { id: string; fileId: string; classification: string; status: string; upload: Ticket };
  if (body) {
    const up = await app.inject({ method: "POST", url: out.upload.url, ...form(out.upload.fields, body) });
    expect(up.statusCode, up.body).toBe(204);
  }
  return out;
}
type Doc = { id: string; docType: string; classification: string; status: string; reason: string | null; placementId: string | null; sha256: string | null };
const list = async (who: string, path: string) => {
  const r = await call(who, "GET", path);
  expect(r.statusCode, r.body).toBe(200);
  return r.json() as { items: Doc[]; canUpload: boolean; canUploadRestricted: boolean; canViewRestricted: boolean };
};

/** r1a's own active Dallas candidate. */
const own = () => candidates.find((c) => c.recruiterId === U.r1a && c.visibility === "team" && c.marketingStatus === "active")!;

describe("upload, scan, promote (local driver, fake scanner)", () => {
  it("an internal document goes quarantine -> clean/documents; a restricted one -> restricted/documents", async () => {
    const internal = await upload("r1a", `/api/v1/candidates/${own().id}/documents`, "offer_letter", pdf("offer"));
    expect(internal).toMatchObject({ classification: "internal", status: "pending" });
    expect(internal.upload.fields.key).toBe(`quarantine/documents/${internal.fileId}`);
    const restricted = await upload("hr", `/api/v1/candidates/${own().id}/documents`, "i9", pdf("i9"));
    expect(restricted).toMatchObject({ classification: "restricted" });
    expect(await exists(join(dir, "quarantine/documents", restricted.fileId))).toBe(true);

    await runScan();
    const docs = (await list("hr", `/api/v1/candidates/${own().id}/documents`)).items;
    expect(docs.find((d) => d.id === internal.id)).toMatchObject({ status: "clean", classification: "internal", reason: null });
    expect(docs.find((d) => d.id === restricted.id)).toMatchObject({ status: "clean", classification: "restricted", docType: "i9" });
    expect(await readFile(join(dir, "clean/documents", internal.fileId))).toEqual(pdf("offer"));
    expect(await readFile(join(dir, "restricted/documents", restricted.fileId))).toEqual(pdf("i9"));
    expect(await exists(join(dir, "clean/documents", restricted.fileId))).toBe(false);
    expect(await exists(join(dir, "quarantine/documents", restricted.fileId))).toBe(false);
    const audit = (await db.admin.query(`SELECT changes FROM eureka.audit_event WHERE action = 'document.scanned' AND entity_id = $1`, [restricted.fileId])).rows;
    expect(audit).toEqual([{ changes: { status: "clean", result: "NO_THREATS_FOUND" } }]);
  });

  it.each([
    ["EICAR (infected; the file is deleted)", "i9", pdf(EICAR_TEST_STRING), PDF, "infected", "THREATS_FOUND"],
    ["HTML declared as PDF", "other", Buffer.from("<html><script>alert(1)</script></html>"), PDF, "rejected", "BAD_CONTENT"],
    ["PDF with JavaScript", "offer_letter", Buffer.from("%PDF-1.7\n1 0 obj << /OpenAction << /S /JavaScript /JS (x) >> >>\n%%EOF"), PDF, "rejected", "ACTIVE_CONTENT"],
    ["PNG with an appended tail", "drivers_license", tinyPng(Buffer.from("<html>")), "image/png", "rejected", "BAD_CONTENT"],
    ["a scan that fails", "other", pdf("EUREKA-FAKE-SCAN:FAILED"), PDF, "failed", "FAILED"],
  ])("%s -> %s", async (_n, docType, body, type, status, reason) => {
    const cand = await newCandidate(db, { teamId: own().teamId, recruiterId: U.r1a, locationId: own().locationId });
    const u = await upload("hr", `/api/v1/candidates/${cand.id}/documents`, docType, body, type);
    await runScan();
    const d = (await list("hr", `/api/v1/candidates/${cand.id}/documents`)).items[0]!;
    expect(d).toMatchObject({ id: u.id, status, reason });
    expect((await call("hr", "POST", `/api/v1/documents/${u.id}/download`)).statusCode).toBe(docType === "i9" || docType === "drivers_license" ? 403 : 409);
    if (status === "infected") expect(await exists(join(dir, "quarantine/documents", u.fileId))).toBe(false);
    expect(await exists(join(dir, "restricted/documents", u.fileId))).toBe(false);
    expect(await exists(join(dir, "clean/documents", u.fileId))).toBe(false);
  });

  it("PNG and JPEG images are accepted", async () => {
    const cand = await newCandidate(db, { teamId: own().teamId, recruiterId: U.r1a, locationId: own().locationId });
    await upload("imm", `/api/v1/candidates/${cand.id}/documents`, "work_authorization", tinyPng(), "image/png");
    await upload("imm", `/api/v1/candidates/${cand.id}/documents`, "drivers_license", tinyJpeg(), "image/jpeg");
    await runScan();
    expect((await list("imm", `/api/v1/candidates/${cand.id}/documents`)).items.map((d) => d.status)).toEqual(["clean", "clean"]);
  });

  it("upload policy: the signed POST pins key, type and exact size; nothing else is accepted", async () => {
    const r = await call("hr", "POST", `/api/v1/candidates/${own().id}/documents`, { docType: "i9", contentType: PDF, size: 10 });
    const t = r.json().upload as Ticket;
    const wrongSize = await app.inject({ method: "POST", url: t.url, ...form(t.fields, Buffer.alloc(11, 0x41)) });
    expect(wrongSize.statusCode).toBe(400);
    const wrongType = await app.inject({ method: "POST", url: t.url, ...form({ ...t.fields, "Content-Type": "text/html" }, Buffer.alloc(10, 0x41)) });
    expect(wrongType.statusCode).toBe(403);
    const wrongKey = await app.inject({ method: "POST", url: t.url, ...form({ ...t.fields, key: `restricted/documents/${r.json().fileId}` }, Buffer.alloc(10, 0x41)) });
    expect(wrongKey.statusCode).toBe(403);
    expect(await exists(join(dir, "restricted/documents", r.json().fileId))).toBe(false);
  });

  it.each([
    [{ docType: "i9", contentType: "text/html", size: 10 }],
    [{ docType: "i9", contentType: "image/gif", size: 10 }],
    [{ docType: "passport", contentType: PDF, size: 10 }],
    [{ docType: "i9", contentType: PDF, size: 15 * 1024 * 1024 + 1 }],
    [{ docType: "i9", contentType: PDF, size: 0 }],
    [{ docType: "i9", contentType: PDF }],
  ])("rejects %j with 422", async (body) => {
    expect((await call("hr", "POST", `/api/v1/candidates/${own().id}/documents`, body)).statusCode).toBe(422);
  });

  it("at most five uploads per candidate wait at once (409)", async () => {
    const cand = await newCandidate(db, { teamId: own().teamId, recruiterId: U.r1a, locationId: own().locationId });
    for (let i = 0; i < 5; i++) await upload("r1a", `/api/v1/candidates/${cand.id}/documents`, "other", null);
    const r = await call("r1a", "POST", `/api/v1/candidates/${cand.id}/documents`, { docType: "other", contentType: PDF, size: 10 });
    expect(r.statusCode).toBe(409);
    expect(r.json().detail).toBe("too_many_pending");
  });

  it("placement documents: listed on the placement and the candidate; Immigration uses the candidate route", async () => {
    const cand = await newCandidate(db, { teamId: own().teamId, recruiterId: U.r1a, locationId: own().locationId });
    const placement = (await createPlacement(db, U.r1a, await selectedSubmission(db, U.r1a, cand.id))).id;
    const d = await upload("hr", `/api/v1/placements/${placement}/documents`, "i9", pdf("placement i9"));
    await upload("r1a", `/api/v1/placements/${placement}/documents`, "offer_letter", pdf("placement offer"));
    expect((await list("hr", `/api/v1/placements/${placement}/documents`)).items.map((x) => x.placementId)).toEqual([placement, placement]);
    expect((await list("imm", `/api/v1/candidates/${cand.id}/documents`)).items.find((x) => x.id === d.id)).toMatchObject({ placementId: placement });
    expect((await call("imm", "GET", `/api/v1/placements/${placement}/documents`)).statusCode).toBe(404);
    expect((await call("r2a", "GET", `/api/v1/placements/${placement}/documents`)).statusCode).toBe(404);
    // The recruiter sees the internal one only.
    expect((await list("r1a", `/api/v1/placements/${placement}/documents`)).items.map((x) => x.docType)).toEqual(["offer_letter"]);
    const r = await call("r1a", "POST", `/api/v1/placements/${placement}/documents`, { docType: "i9", contentType: PDF, size: 10 });
    expect(r.statusCode).toBe(403);
  });
});

describe("restricted access matrix (every fixture user; with, without and expired step-up)", () => {
  let restricted: { id: string; fileId: string };
  let internal: { id: string; fileId: string };
  const body = pdf("restricted matrix");

  beforeAll(async () => {
    restricted = await upload("hr", `/api/v1/candidates/${own().id}/documents`, "work_authorization", body);
    internal = await upload("r1a", `/api/v1/candidates/${own().id}/documents`, "other", pdf("internal matrix"));
    await runScan();
  });

  it.each(users)("%s", async (key) => {
    const access = toUserAccess(key);
    const readable = candidateVisible(resolveScope(access, "candidate:read"), own());
    const a = documentAccess(access, own());
    const s = await login(emailOf(key), true); // a fresh session: no step-up yet

    // 403 without document:read at all (route guard); 404 when the candidate is not readable; 403 when not covered.
    const holds = can(access, "document:read");
    const refused = !holds ? 403 : !readable ? 404 : null;
    const listed = await call(s, "GET", `/api/v1/candidates/${own().id}/documents`);
    if (refused) expect(listed.statusCode).toBe(refused);
    else if (!a.read) expect(listed.statusCode).toBe(403);
    else {
      const ids = (listed.json().items as Doc[]).map((d) => d.id);
      expect(ids.includes(restricted.id)).toBe(a.readRestricted);
      expect(ids.includes(internal.id)).toBe(true);
    }

    const before = await call(s, "POST", `/api/v1/documents/${restricted.id}/download`);
    if (!holds) {
      expect(before.statusCode).toBe(403);
    } else if (!a.readRestricted || !readable) {
      expect(before.statusCode).toBe(404);
    } else {
      expect(before.statusCode).toBe(403);
      expect(before.json().detail).toBe("step_up_required");
    }

    const stepped = await call(s, "POST", "/api/auth/step-up/dev");
    expect(stepped.statusCode).toBe(200);
    expect((await call(s, "GET", "/api/auth/step-up")).json()).toMatchObject({ active: true, method: "dev", mode: "dev" });
    const after = await call(s, "POST", `/api/v1/documents/${restricted.id}/download`);
    if (a.read && readable && a.readRestricted) {
      expect(after.statusCode, after.body).toBe(200);
      const { url, expiresAt } = after.json() as { url: string; expiresAt: string };
      expect(Date.parse(expiresAt) - Date.now()).toBeLessThanOrEqual(300_000);
      expect(Date.parse(expiresAt) - Date.now()).toBeGreaterThan(240_000);
      const got = await app.inject({ method: "GET", url });
      expect(got.statusCode).toBe(200);
      expect(got.rawPayload.equals(body)).toBe(true);
      expect(String(got.headers["content-disposition"])).toMatch(/^attachment; filename="work-authorization-[0-9a-f]{8}\.pdf"$/);
      expect(["hr", "acct", "imm"]).toContain(key);
    } else {
      expect(after.statusCode).toBe(holds ? 404 : 403);
    }

    // Internal documents need no step-up.
    const plain = await call(await login(emailOf(key), true), "POST", `/api/v1/documents/${internal.id}/download`);
    expect(plain.statusCode).toBe(!holds ? 403 : a.read && readable ? 200 : 404);
  });

  it("an expired step-up, or one taken in another session, does not open restricted documents", async () => {
    const s = await login(emailOf("acct"), true);
    expect((await call(s, "POST", "/api/auth/step-up/dev")).statusCode).toBe(200);
    expect((await call(s, "POST", `/api/v1/documents/${restricted.id}/download`)).statusCode).toBe(200);
    const other = await login(emailOf("acct"), true);
    expect((await call(other, "POST", `/api/v1/documents/${restricted.id}/download`)).json().detail).toBe("step_up_required");
    // Time travel: the grant ran out.
    const c = await db.admin.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL session_replication_role = replica");
      await c.query(`UPDATE eureka.step_up_grant SET created_at = now() - interval '11 minutes', expires_at = now() - interval '1 second'
                     WHERE user_id = $1`, [U.acct]);
      await c.query("COMMIT");
    } finally {
      c.release();
    }
    expect((await call(s, "GET", "/api/auth/step-up")).json()).toMatchObject({ active: false, expiresAt: null });
    const r = await call(s, "POST", `/api/v1/documents/${restricted.id}/download`);
    expect(r.statusCode).toBe(403);
    expect(r.json().detail).toBe("step_up_required");
  });

  it("logging out ends the step-up with the session", async () => {
    const s = await login(emailOf("imm"), true);
    await call(s, "POST", "/api/auth/step-up/dev");
    expect((await call(s, "POST", "/api/auth/logout")).statusCode).toBe(204);
    expect((await call(s, "POST", `/api/v1/documents/${restricted.id}/download`)).statusCode).toBe(401);
  });

  it("Documents Team and Associate HR (internal documents only) cannot see or open restricted ones", async () => {
    for (const role of ["documents_team", "associate_hr"] as const) {
      const u = await extraUser(db, `ext-${role}`, role);
      const s = await login(`ext-${role}@eureka.example`, true);
      await call(s, "POST", "/api/auth/step-up/dev");
      const ids = ((await call(s, "GET", `/api/v1/candidates/${own().id}/documents`)).json().items as Doc[]).map((d) => d.id);
      expect(ids).toContain(internal.id);
      expect(ids).not.toContain(restricted.id);
      expect((await call(s, "POST", `/api/v1/documents/${restricted.id}/download`)).statusCode).toBe(404);
      expect((await call(s, "POST", `/api/v1/candidates/${own().id}/documents`, { docType: "i9", contentType: PDF, size: 10 })).statusCode).toBe(403);
      expect((await call(s, "POST", `/api/v1/candidates/${own().id}/documents`, { docType: "offer_letter", contentType: PDF, size: 10 })).statusCode).toBe(201);
      void u;
    }
  });
});

describe("access log, audit rows and the audit export (ids only)", () => {
  let restricted: { id: string; fileId: string };

  beforeAll(async () => {
    const cand = await newCandidate(db, { teamId: own().teamId, recruiterId: U.r1a, locationId: own().locationId });
    restricted = await upload("hr", `/api/v1/candidates/${cand.id}/documents`, "i9", pdf("audit"));
    await runScan();
    const s = await login(emailOf("hr"), true);
    await call(s, "POST", "/api/auth/step-up/dev");
    expect((await call(s, "POST", `/api/v1/documents/${restricted.id}/download`)).statusCode).toBe(200);
  });

  it("restricted readers see one document's log; org admins see all; others are refused", async () => {
    const hr = await call("acct", "GET", `/api/v1/document-access?documentId=${restricted.id}`);
    expect(hr.statusCode, hr.body).toBe(200);
    expect(hr.json().items).toEqual([{ id: expect.any(String), documentId: restricted.id, docType: "i9", classification: "restricted",
      user: { id: U.hr, name: "hr" }, action: "download", steppedUp: true, at: expect.any(String) }]);
    expect((await call("acct", "GET", `/api/v1/document-access`)).statusCode).toBe(422);
    const all = await call("admin", "GET", `/api/v1/document-access?limit=200`);
    expect(all.statusCode).toBe(200);
    expect((all.json().items as { documentId: string }[]).some((i) => i.documentId === restricted.id)).toBe(true);
    for (const key of ["r1a", "l1", "m1", "ceo", "locD", "coach"] as const) {
      expect((await call(key, "GET", `/api/v1/document-access?documentId=${restricted.id}`)).statusCode).toBe(403);
    }
    expect((await call("acct", "GET", `/api/v1/document-access?documentId=${restricted.id}&extra=1`)).statusCode).toBe(422);
  });

  it("each view is in the audit export as document.viewed with ids and codes only", async () => {
    const DAY = "2026-03-20";
    // Backdate this document's audit rows to a finished UTC day the worker may export.
    await db.admin.query(`UPDATE eureka.audit_event SET at = $2 WHERE entity_id = $1 OR entity_id = $3`,
      [restricted.id, `${DAY}T12:00:00Z`, restricted.fileId]);
    const exportDir = await mkdtemp(join(tmpdir(), "eureka-docs-audit-"));
    try {
      const r = await exportAuditDay(db.worker, new DirSink(exportDir), DAY);
      const lines = gunzipSync(await readFile(join(exportDir, r.objectKey))).toString("utf8").trimEnd().split("\n").map((l) => JSON.parse(l));
      const viewed = lines.filter((l) => l.action === "document.viewed");
      expect(viewed).toHaveLength(1);
      expect(viewed[0]).toMatchObject({ actor_id: U.hr, entity_type: "document", entity_id: restricted.id });
      expect(Object.keys(viewed[0].changes).sort()).toEqual(["accessId", "candidateId", "classification", "docType", "fileId", "placementId", "stepUpGrantId"]);
      expect(lines.map((l) => l.action).sort()).toEqual(["document.scanned", "document.upload_requested", "document.viewed"]);
      const text = JSON.stringify(lines);
      expect(text).not.toMatch(/@eureka\.example|PlCand|Placed|\.pdf|quarantine\/|restricted\/documents/);
    } finally {
      await rm(exportDir, { recursive: true, force: true });
    }
  });
});

describe("Google step-up (OIDC max_age / auth_time)", () => {
  let gapp: NestFastifyApplication;
  let key: CryptoKey;
  let restrictedId: string;
  let tokenResponse: () => Promise<string>;

  beforeAll(async () => {
    gapp = await createApp(loadConfig({
      NODE_ENV: "test", AUTH_MODE: "google", SESSION_SECRET: SECRET, GOOGLE_CLIENT_ID: "client-123", GOOGLE_CLIENT_SECRET: "s",
      GOOGLE_HOSTED_DOMAIN: "eureka.example", PUBLIC_BASE_URL: "http://localhost:5173",
      DATABASE_URL: `postgres://eureka_app:eureka_app_test@${adminUrl.host}/${db.name}`, LOCAL_STORAGE_DIR: dir,
    }));
    const pair = await generateKeyPair("RS256");
    key = pair.privateKey as CryptoKey;
    const jwk = { ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "RS256" };
    const oidc = gapp.get(OidcService);
    oidc.useKeySet(createLocalJWKSet({ keys: [jwk] }));
    oidc.fetchImpl = (async () => new Response(JSON.stringify({ id_token: await tokenResponse() }), { status: 200 })) as typeof fetch;
    await db.admin.query(`UPDATE eureka.app_user SET google_sub = 'google-sub-' || $2 WHERE id = $1`, [U.imm, "imm"]);
    const cand = await newCandidate(db, { teamId: own().teamId, recruiterId: U.r1a, locationId: own().locationId });
    restrictedId = (await upload("imm", `/api/v1/candidates/${cand.id}/documents`, "work_authorization", pdf("google step-up"))).id;
    await runScan();
  });
  afterAll(async () => { await gapp?.close(); });

  /** A session for `userId` minted directly (Google sign-in itself is tested in api.int.test.ts). */
  async function googleSession(userId: string): Promise<Session> {
    const sid = randomBytes(32).toString("base64url");
    await db.admin.query(`INSERT INTO eureka.session (id_hash, user_id, expires_at, auth_time, access_version)
      SELECT $1, id, now() + interval '1 hour', now() - interval '2 hours', access_version FROM eureka.app_user WHERE id = $2`,
      [createHash("sha256").update(sid).digest(), userId]);
    const cookie = `eureka_sid=${sid}`;
    const me = await gapp.inject({ method: "GET", url: "/api/v1/me", headers: { cookie } });
    return { cookie, csrf: me.json().csrfToken as string };
  }
  const idToken = (claims: Record<string, unknown>) => new SignJWT({ email_verified: true, email: "imm@eureka.example", hd: "eureka.example", ...claims })
    .setProtectedHeader({ alg: "RS256", kid: "k1" }).setIssuer("https://accounts.google.com").setAudience(String(claims.aud ?? "client-123"))
    .setSubject(String(claims.sub ?? "google-sub-imm")).setIssuedAt().setExpirationTime("5m").sign(key);

  /** Starts a step-up and follows Google's redirect back with `claims` in the ID token. */
  async function stepUp(s: Session, claims: (nonce: string) => Record<string, unknown>, returnTo = "/candidates/x?tab=documents") {
    const start = await gapp.inject({ method: "POST", url: "/api/auth/step-up/start", payload: { returnTo }, headers: { cookie: s.cookie, "x-csrf-token": s.csrf } });
    expect(start.statusCode, start.body).toBe(200);
    const google = new URL(start.json().redirectUrl as string);
    const stepCookie = String(start.headers["set-cookie"]).split(";")[0]!;
    const nonce = google.searchParams.get("nonce")!;
    tokenResponse = () => idToken(claims(nonce));
    const cb = await gapp.inject({ method: "GET", url: `/api/auth/step-up/callback?code=c1&state=${google.searchParams.get("state")}`,
      headers: { cookie: `${s.cookie}; ${stepCookie}` } });
    return { google, cb, stepCookie };
  }
  const download = (s: Session) =>
    gapp.inject({ method: "POST", url: `/api/v1/documents/${restrictedId}/download`, headers: { cookie: s.cookie, "x-csrf-token": s.csrf } });

  it("asks Google for a fresh sign-in (max_age=0, prompt=login, the user's account) and grants step-up on a fresh auth_time", async () => {
    const s = await googleSession(U.imm);
    expect((await download(s)).json().detail).toBe("step_up_required");
    const { google, cb } = await stepUp(s, (nonce) => ({ nonce, auth_time: Math.floor(Date.now() / 1000) }));
    expect(google.origin + google.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(Object.fromEntries(google.searchParams)).toMatchObject({ max_age: "0", prompt: "login", login_hint: "imm@eureka.example",
      hd: "eureka.example", code_challenge_method: "S256", redirect_uri: "http://localhost:5173/api/auth/step-up/callback" });
    expect(cb.statusCode).toBe(302);
    expect(cb.headers.location).toBe("http://localhost:5173/candidates/x?tab=documents");
    expect((await gapp.inject({ method: "GET", url: "/api/auth/step-up", headers: { cookie: s.cookie } })).json()).toMatchObject({ active: true, method: "google", mode: "google" });
    expect((await download(s)).statusCode).toBe(200);
  });

  it.each([
    ["no auth_time (Google did not prove a sign-in)", (nonce: string) => ({ nonce })],
    ["auth_time older than the challenge (no re-authentication)", (nonce: string) => ({ nonce, auth_time: Math.floor(Date.now() / 1000) - 3600 })],
    ["another Google account", (nonce: string) => ({ nonce, auth_time: Math.floor(Date.now() / 1000), sub: "google-sub-someone-else" })],
    ["a nonce from another flow", () => ({ nonce: "other", auth_time: Math.floor(Date.now() / 1000) })],
    ["a token for another audience", (nonce: string) => ({ nonce, auth_time: Math.floor(Date.now() / 1000), aud: "other-client" })],
  ])("refuses %s", async (_n, claims) => {
    const s = await googleSession(U.imm);
    const { cb } = await stepUp(s, claims);
    expect(cb.statusCode).toBe(302);
    expect(cb.headers.location).toBe("http://localhost:5173/candidates/x?tab=documents&stepUp=failed");
    expect((await gapp.inject({ method: "GET", url: "/api/auth/step-up", headers: { cookie: s.cookie } })).json()).toMatchObject({ active: false });
    expect((await download(s)).json().detail).toBe("step_up_required");
  });

  it("a replayed callback grants nothing; another session cannot use the callback", async () => {
    const s = await googleSession(U.imm);
    const fresh = (nonce: string) => ({ nonce, auth_time: Math.floor(Date.now() / 1000) });
    const { google, stepCookie } = await stepUp(s, fresh);
    const before = (await db.admin.query(`SELECT count(*)::int n FROM eureka.step_up_grant WHERE user_id = $1`, [U.imm])).rows[0].n;
    const replay = await gapp.inject({ method: "GET", url: `/api/auth/step-up/callback?code=c1&state=${google.searchParams.get("state")}`,
      headers: { cookie: `${s.cookie}; ${stepCookie}` } });
    expect(replay.headers.location).toMatch(/stepUp=failed$/);
    expect((await db.admin.query(`SELECT count(*)::int n FROM eureka.step_up_grant WHERE user_id = $1`, [U.imm])).rows[0].n).toBe(before);
    // The flow cookie is bound to the session that started it.
    const other = await googleSession(U.imm);
    const stolen = await gapp.inject({ method: "GET", url: `/api/auth/step-up/callback?code=c1&state=${google.searchParams.get("state")}`,
      headers: { cookie: `${other.cookie}; ${stepCookie}` } });
    expect(stolen.statusCode).toBe(403);
    expect((await gapp.inject({ method: "GET", url: "/api/auth/step-up", headers: { cookie: other.cookie } })).json()).toMatchObject({ active: false });
  });

  it("start refuses an off-site return path; dev step-up does not exist in Google mode", async () => {
    const s = await googleSession(U.imm);
    for (const returnTo of ["https://evil.example/", "//evil.example/x", "/a\\b", "javascript:alert(1)"]) {
      const r = await gapp.inject({ method: "POST", url: "/api/auth/step-up/start", payload: { returnTo }, headers: { cookie: s.cookie, "x-csrf-token": s.csrf } });
      expect(r.statusCode, returnTo).toBe(422);
    }
    expect((await gapp.inject({ method: "POST", url: "/api/auth/step-up/dev", headers: { cookie: s.cookie, "x-csrf-token": s.csrf } })).statusCode).toBe(404);
    // In dev mode the Google endpoints do not exist.
    expect((await call("imm", "POST", "/api/auth/step-up/start", { returnTo: "/" })).statusCode).toBe(404);
    // CSRF: start is a state-changing POST.
    expect((await gapp.inject({ method: "POST", url: "/api/auth/step-up/start", payload: { returnTo: "/" }, headers: { cookie: s.cookie } })).statusCode).toBe(403);
  });
});

describe("configuration", () => {
  it("dev step-up is unreachable in production (AUTH_MODE=dev is refused there); TTL is capped at 15 minutes", () => {
    const base = { NODE_ENV: "production", DATABASE_URL: "postgres://x@y/z", SESSION_SECRET: SECRET, ORIGIN_VERIFY_SECRET: "o".repeat(40), DOCUMENTS_BUCKET: "d-1" };
    expect(() => loadConfig({ ...base, AUTH_MODE: "dev" })).toThrow(/AUTH_MODE=dev is not allowed/);
    const dev = { NODE_ENV: "test", AUTH_MODE: "dev", DATABASE_URL: "postgres://x@y/z", SESSION_SECRET: SECRET };
    expect(loadConfig(dev).STEP_UP_TTL_MINUTES).toBe(10);
    expect(() => loadConfig({ ...dev, STEP_UP_TTL_MINUTES: "16" })).toThrow();
    expect(() => loadConfig({ ...dev, STEP_UP_MAX_AGE_SECONDS: "3600" })).toThrow();
  });
});

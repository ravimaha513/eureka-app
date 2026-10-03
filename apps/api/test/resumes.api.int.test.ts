import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { can, candidateVisible, resolveScope, resumeAccess } from "@eureka/shared";
import { createApp } from "../src/app.module.js";
import { loadConfig } from "../src/platform/config.js";
import { EICAR_TEST_STRING } from "../src/platform/storage/local-files.js";
import { loadWorkerConfig } from "../src/worker/config.js";
import { LocalDocumentStore, type DocumentStore } from "../src/worker/document-store.js";
import { DEFAULT_RESUME_SCAN_OPTIONS, resumeScanJob, type ResumeScanOptions } from "../src/worker/jobs/resume-scan.js";
import { createLogger, silentLogger } from "../src/worker/log.js";
import { JobRunner } from "../src/worker/runner.js";
import { createTestDb, type TestDb } from "./db-harness.js";
import { U, seedFixtures, toUserAccess, type FixtureCandidate } from "./fixtures.js";

/**
 * Resumes end to end on the local document driver and the fake scanner:
 * presigned upload -> quarantine -> scan job -> clean/ -> audited download,
 * plus the authorization matrix and the scan outcomes (design A6.5, B8).
 */
let db: TestDb;
let app: NestFastifyApplication;
let dir: string;
let candidates: FixtureCandidate[];
const users = Object.keys(U) as (keyof typeof U)[];
const PDF = "application/pdf";
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

beforeAll(async () => {
  db = await createTestDb();
  candidates = await seedFixtures(db.admin);
  dir = await mkdtemp(join(tmpdir(), "eureka-docs-"));
  const url = new URL(process.env.TEST_PG_ADMIN_URL ?? "postgres://postgres:postgres@127.0.0.1:5432");
  app = await createApp(loadConfig({
    NODE_ENV: "test", AUTH_MODE: "dev", SESSION_SECRET: "test-secret-test-secret-test-secret-123",
    DATABASE_URL: `postgres://eureka_app:eureka_app_test@${url.host}/${db.name}`, LOCAL_STORAGE_DIR: dir,
  }));
}, 120_000);

afterAll(async () => {
  await app?.close();
  await db?.drop();
  if (dir) await rm(dir, { recursive: true, force: true });
});

type Session = { cookie: string; csrf: string };
const sessions = new Map<string, Session>();
async function login(key: keyof typeof U): Promise<Session> {
  const cached = sessions.get(key);
  if (cached) return cached;
  const res = await app.inject({ method: "POST", url: "/api/auth/dev-login", payload: { email: `${key}@eureka.example` } });
  expect(res.statusCode).toBe(204);
  const cookie = String(res.headers["set-cookie"]).split(";")[0]!;
  const me = await app.inject({ method: "GET", url: "/api/v1/me", headers: { cookie } });
  const s = { cookie, csrf: me.json().csrfToken as string };
  sessions.set(key, s);
  return s;
}
async function call(key: keyof typeof U, method: "GET" | "POST", url: string, payload?: unknown) {
  const s = await login(key);
  return app.inject({ method, url, payload: payload as never, headers: { cookie: s.cookie, ...(method !== "GET" ? { "x-csrf-token": s.csrf } : {}) } });
}

/** A browser-style multipart POST of the presigned fields plus the file (last). */
function form(fields: Record<string, string>, file: Buffer, fileName = "Jane_Doe_Resume.pdf") {
  const b = "----eurekaTestBoundary";
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  parts.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: application/octet-stream\r\n\r\n`), file, Buffer.from(`\r\n--${b}--\r\n`));
  return { payload: Buffer.concat(parts), headers: { "content-type": `multipart/form-data; boundary=${b}` } };
}

const pdf = (text = "hello") => Buffer.from(`%PDF-1.7\n% fictional resume ${text}\n%%EOF\n`);
const runJob = async (opts: Partial<ResumeScanOptions> = {}) => {
  await new JobRunner(db.worker, [resumeScanJob(new LocalDocumentStore(dir), { ...DEFAULT_RESUME_SCAN_OPTIONS, ...opts })], silentLogger).tick();
};

/** Requests an upload as `who` and posts `body` to the returned target; returns the resume id. */
async function upload(who: keyof typeof U, candidateId: string, body: Buffer | null, contentType = PDF) {
  const r = await call(who, "POST", `/api/v1/candidates/${candidateId}/resumes`, { contentType, size: body?.length ?? 100 });
  expect(r.statusCode, r.body).toBe(201);
  const { id, upload: ticket } = r.json() as { id: string; upload: { url: string; fields: Record<string, string>; expiresAt: string } };
  if (body) {
    const f = form(ticket.fields, body);
    const up = await app.inject({ method: "POST", url: ticket.url, ...f });
    expect(up.statusCode, up.body).toBe(204);
  }
  return { id, ticket };
}
const list = async (who: keyof typeof U, candidateId: string) => {
  const r = await call(who, "GET", `/api/v1/candidates/${candidateId}/resumes`);
  expect(r.statusCode, r.body).toBe(200);
  return r.json() as { items: { id: string; status: string; reason: string | null; version: number | null; isCurrent: boolean; sha256: string | null }[]; canUpload: boolean };
};
const exists = (p: string) => stat(p).then(() => true, () => false);

/** l1's team candidates (t1); r1a owns the first. */
const cand = (i: number) => candidates.filter((c) => c.recruiterId === U.r1a && c.visibility === "team")[i]!;

describe("upload, scan, promote, download (local driver, fake scanner)", () => {
  let cleanId: string;

  it("a recruiter uploads a resume for their own candidate; it is pending until scanned", async () => {
    const body = pdf("v1");
    const { id, ticket } = await upload("r1a", cand(0).id, body);
    expect(ticket.url).toBe("/api/local-storage/upload");
    expect(ticket.fields.key).toBe(`quarantine/resumes/${id}`);
    expect(await exists(join(dir, "quarantine/resumes", id))).toBe(true);
    const before = await list("r1a", cand(0).id);
    expect(before.items[0]).toMatchObject({ id, status: "pending", version: null, isCurrent: false });
    expect(before.canUpload).toBe(true);
    await expect(call("r1a", "POST", `/api/v1/candidates/${cand(0).id}/resumes/${id}/download`).then((r) => r.statusCode)).resolves.toBe(409);

    await runJob();
    const after = await list("r1a", cand(0).id);
    expect(after.items[0]).toMatchObject({ id, status: "clean", version: 1, isCurrent: true, reason: null });
    expect(after.items[0]!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(await readFile(join(dir, "clean/resumes", id))).toEqual(body);
    expect(await exists(join(dir, "quarantine/resumes", id))).toBe(false);
    cleanId = id;
  });

  it("download: short-lived signed link, attachment, generated name, same bytes; audited by id", async () => {
    const r = await call("r1a", "POST", `/api/v1/candidates/${cand(0).id}/resumes/${cleanId}/download`);
    expect(r.statusCode, r.body).toBe(200);
    const { url, expiresAt } = r.json() as { url: string; expiresAt: string };
    expect(Date.parse(expiresAt) - Date.now()).toBeLessThanOrEqual(60_000);
    const file = await app.inject({ method: "GET", url });
    expect(file.statusCode).toBe(200);
    expect(file.headers["content-disposition"]).toBe('attachment; filename="resume-v1.pdf"');
    expect(file.headers["content-type"]).toBe(PDF);
    expect(file.rawPayload).toEqual(pdf("v1"));
    // A tampered link is refused.
    expect((await app.inject({ method: "GET", url: url.replace("signature=", "signature=x") })).statusCode).toBe(403);
  });

  it("a second clean upload becomes version 2 and current", async () => {
    const { id } = await upload("l1", cand(0).id, pdf("v2"));
    await runJob();
    const items = (await list("r1a", cand(0).id)).items;
    expect(items.find((i) => i.id === id)).toMatchObject({ status: "clean", version: 2, isCurrent: true });
    expect(items.find((i) => i.id === cleanId)).toMatchObject({ version: 1, isCurrent: false });
  });

  it("the upload target enforces the signed policy: size, type, key and no extra fields", async () => {
    const { ticket } = await upload("r1a", cand(1).id, null);
    const post = (fields: Record<string, string>, body: Buffer) => app.inject({ method: "POST", url: ticket.url, ...form(fields, body) });
    expect((await post(ticket.fields, Buffer.alloc(99, 1))).statusCode).toBe(400);   // declared 100 bytes
    expect((await post({ ...ticket.fields, "Content-Type": "text/html" }, Buffer.alloc(100))).statusCode).toBe(403);
    expect((await post({ ...ticket.fields, key: `quarantine/resumes/${cleanId}` }, Buffer.alloc(100))).statusCode).toBe(403);
    expect((await post({ ...ticket.fields, tagging: "<Tagging/>" }, Buffer.alloc(100))).statusCode).toBe(400);
    expect((await post({ ...ticket.fields, signature: "AAAA" }, Buffer.alloc(100))).statusCode).toBe(403);
  });

  it("signed policies are bound to their purpose: a download link is not an upload policy and vice versa", async () => {
    const { ticket } = await upload("r1a", cand(1).id, null);
    const dl = new URL((await call("r1a", "POST", `/api/v1/candidates/${cand(0).id}/resumes/${cleanId}/download`)).json().url, "http://x");
    const asUpload = { key: ticket.fields.key!, "Content-Type": PDF, policy: dl.searchParams.get("policy")!, signature: dl.searchParams.get("signature")! };
    expect((await app.inject({ method: "POST", url: ticket.url, ...form(asUpload, Buffer.alloc(100)) })).statusCode).toBe(403);
    const asDownload = `/api/local-storage/object?policy=${ticket.fields.policy}&signature=${ticket.fields.signature}`;
    expect((await app.inject({ method: "GET", url: asDownload })).statusCode).toBe(403);
  });

  it("the presigned upload is short-lived (120 s)", async () => {
    const { ticket } = await upload("l1", cand(1).id, null);
    expect(Date.parse(ticket.expiresAt) - Date.now()).toBeLessThanOrEqual(120_000);
    expect(Date.parse(ticket.expiresAt) - Date.now()).toBeGreaterThan(100_000);
  });
});

describe("scan outcomes", () => {
  const outcome = async (id: string) => (await db.admin.query(`SELECT status, scan_result, is_current, version FROM eureka.resume WHERE id = $1`, [id])).rows[0];

  it("infected: recorded, quarantine copy deleted, never downloadable", async () => {
    const { id } = await upload("r1a", cand(2).id, Buffer.from(`%PDF-1.4\n${EICAR_TEST_STRING}\n`));
    await runJob();
    expect(await outcome(id)).toMatchObject({ status: "infected", scan_result: "THREATS_FOUND", is_current: false, version: null });
    expect(await exists(join(dir, "quarantine/resumes", id))).toBe(false);
    expect(await exists(join(dir, "clean/resumes", id))).toBe(false);
    expect((await call("r1a", "POST", `/api/v1/candidates/${cand(2).id}/resumes/${id}/download`)).statusCode).toBe(409);
  });

  it("scan failure: recorded as failed; the object stays in quarantine (lifecycle expiry)", async () => {
    const { id } = await upload("r1a", cand(2).id, Buffer.from("%PDF-1.4 EUREKA-FAKE-SCAN:FAILED"));
    await runJob();
    expect(await outcome(id)).toMatchObject({ status: "failed", scan_result: "FAILED" });
    expect(await exists(join(dir, "quarantine/resumes", id))).toBe(true);
    expect(await exists(join(dir, "clean/resumes", id))).toBe(false);
  });

  it("timeout: no scan result in time -> failed (TIMEOUT); still waiting before the timeout", async () => {
    const { id } = await upload("r1a", cand(2).id, Buffer.from("%PDF-1.4 EUREKA-FAKE-SCAN:PENDING"));
    await runJob();
    expect((await outcome(id)).status).toBe("pending");
    await runJob({ scanTimeoutMs: -1 });
    expect(await outcome(id)).toMatchObject({ status: "failed", scan_result: "TIMEOUT" });
  });

  it("magic bytes: a clean scan of bytes that are not the declared type is rejected", async () => {
    const { id } = await upload("r1a", cand(3).id, Buffer.from("MZ\x90\x00 not a pdf"));
    const docx = await upload("r1a", cand(3).id, pdf("pretending to be docx"), DOCX);
    await runJob();
    expect(await outcome(id)).toMatchObject({ status: "rejected", scan_result: "BAD_CONTENT" });
    expect(await outcome(docx.id)).toMatchObject({ status: "rejected", scan_result: "BAD_CONTENT" });
    expect(await exists(join(dir, "clean/resumes", id))).toBe(false);
  });

  it("active content: a clean scan of a PDF with JavaScript is rejected and deleted", async () => {
    const { id } = await upload("l1", cand(3).id, Buffer.from("%PDF-1.7\n1 0 obj << /OpenAction << /S /JavaScript /JS (app.alert(1)) >> >> endobj\n%%EOF\n"));
    await runJob();
    expect(await outcome(id)).toMatchObject({ status: "rejected", scan_result: "ACTIVE_CONTENT" });
    expect(await exists(join(dir, "quarantine/resumes", id))).toBe(false);
    expect(await exists(join(dir, "clean/resumes", id))).toBe(false);
  });

  it("promotion is create-only: a different clean object under the key fails the run instead of overwriting", async () => {
    const { id } = await upload("l1", cand(5).id, pdf("original"));
    await mkdir(join(dir, "clean/resumes"), { recursive: true });
    await writeFile(join(dir, "clean/resumes", id), "someone else's bytes");
    await runJob();
    expect((await outcome(id)).status).toBe("pending");
    const run = (await db.admin.query(`SELECT status, detail FROM eureka.job_run WHERE job_name = 'resume-scan' AND run_key = $1`, [id])).rows[0];
    expect(run).toMatchObject({ status: "failed", detail: { error: expect.stringMatching(/different content/) } });
    expect(await readFile(join(dir, "clean/resumes", id), "utf8")).toBe("someone else's bytes");
  });

  it("a retried promotion that finds its own bytes under the clean key finishes", async () => {
    const body = pdf("retry");
    const { id } = await upload("l1", cand(6).id, body);
    await mkdir(join(dir, "clean/resumes"), { recursive: true });
    await writeFile(join(dir, "clean/resumes", id), body); // as if the database update had failed after the write
    await runJob();
    expect(await outcome(id)).toMatchObject({ status: "clean" });
  });

  it("never uploaded: expired after the upload window and grace", async () => {
    const { id } = await upload("r1a", cand(3).id, null);
    await runJob();
    expect((await outcome(id)).status).toBe("pending");
    const c = await db.admin.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL session_replication_role = replica");
      await c.query(`UPDATE eureka.resume SET upload_expires_at = now() - interval '1 minute' WHERE id = $1`, [id]);
      await c.query("COMMIT");
    } finally {
      c.release();
    }
    await runJob({ uploadGraceMs: 0 });
    expect(await outcome(id)).toMatchObject({ status: "expired", scan_result: "NOT_UPLOADED" });
  });

  it("logs an alert when one quarantine key holds more versions than allowed (replayed upload)", async () => {
    const { id } = await upload("l1", cand(7).id, pdf("replayed"));
    const local = new LocalDocumentStore(dir);
    const replayed: DocumentStore = Object.assign(Object.create(local) as DocumentStore, {
      verdict: async (key: string) => ({ ...(await local.verdict(key)), versions: 5 }),
    });
    const lines: Record<string, unknown>[] = [];
    const log = createLogger({}, (l) => lines.push(JSON.parse(l) as Record<string, unknown>));
    await new JobRunner(db.worker, [resumeScanJob(replayed, { ...DEFAULT_RESUME_SCAN_OPTIONS, maxVersionsPerKey: 3 })], log).tick();
    expect(lines).toContainEqual(expect.objectContaining({ msg: "many uploads to one quarantine key", resumeId: id, versions: 5, alert: true }));
  });

  it("the pending cap answers 409", async () => {
    for (let i = 0; i < 3; i++) await upload("l1", cand(4).id, null);
    const r = await call("l1", "POST", `/api/v1/candidates/${cand(4).id}/resumes`, { contentType: PDF, size: 10 });
    expect(r.statusCode).toBe(409);
    expect(r.json().detail).toBe("too_many_pending");
  });
});

describe("authorization matrix", () => {
  let clean: { candidateId: string; resumeId: string };

  beforeAll(async () => {
    const candidateId = cand(0).id;
    const items = (await list("r1a", candidateId)).items;
    clean = { candidateId, resumeId: items.find((i) => i.status === "clean")!.id };
  });

  const samples = () => [
    cand(0),                                                                                                       // r1a's own (team t1)
    candidates.find((c) => c.recruiterId === U.r1b && c.visibility === "team")!,                                   // r1a's teammate's
    candidates.find((c) => c.teamId !== cand(0).teamId && c.visibility === "all_teams" && c.marketingStatus === "active")!, // other team, open to all
    candidates.find((c) => c.teamId !== cand(0).teamId && c.visibility === "team")!,                               // other team
  ];

  it.each(users)("%s: GET /candidates/:id/resumes", async (key) => {
    const access = toUserAccess(key);
    for (const c of samples()) {
      const res = await call(key, "GET", `/api/v1/candidates/${c.id}/resumes`);
      const expected = !can(access, "document:read") ? 403
        : !candidateVisible(resolveScope(access, "candidate:read"), c) ? 404
        : !resumeAccess(access, c).read ? 403 : 200;
      expect(res.statusCode, `${key} ${c.id} ${res.body}`).toBe(expected);
      if (expected === 200) expect(res.json().canUpload).toBe(resumeAccess(access, c).upload);
    }
  });

  it.each(users)("%s: POST /candidates/:id/resumes (body checked only after scope: invalid body -> 422 when allowed)", async (key) => {
    const access = toUserAccess(key);
    for (const c of samples()) {
      const res = await call(key, "POST", `/api/v1/candidates/${c.id}/resumes`, { contentType: "text/html", size: 1, fileName: "x" });
      const expected = !can(access, "document:upload") ? 403
        : !candidateVisible(resolveScope(access, "candidate:read"), c) ? 404
        : !resumeAccess(access, c).upload ? 403 : 422;
      expect(res.statusCode, `${key} ${c.id} ${res.body}`).toBe(expected);
    }
  });

  it.each(users)("%s: POST .../download of a clean resume", async (key) => {
    const access = toUserAccess(key);
    const c = candidates.find((x) => x.id === clean.candidateId)!;
    const res = await call(key, "POST", `/api/v1/candidates/${clean.candidateId}/resumes/${clean.resumeId}/download`);
    const expected = !can(access, "document:read") ? 403
      : candidateVisible(resolveScope(access, "candidate:read"), c) && resumeAccess(access, c).read ? 200 : 404;
    expect(res.statusCode, `${key} ${res.body}`).toBe(expected);
  });

  it("unknown fields, oversize and wrong types are refused (422)", async () => {
    for (const body of [{ contentType: PDF, size: 15 * 1024 * 1024 + 1 }, { contentType: PDF, size: 0 }, { contentType: "image/png", size: 10 },
      { contentType: PDF, size: 10, key: "quarantine/resumes/mine" }]) {
      expect((await call("r1a", "POST", `/api/v1/candidates/${cand(0).id}/resumes`, body)).statusCode).toBe(422);
    }
  });

  it("a resume id under another candidate is not found", async () => {
    expect((await call("hr", "POST", `/api/v1/candidates/${cand(1).id}/resumes/${clean.resumeId}/download`)).statusCode).toBe(404);
  });
});

describe("audit", () => {
  it("records ids, type, size, version and scan codes only: no file names or personal data", async () => {
    const { rows } = await db.admin.query<{ action: string; actor_id: string | null; entity_type: string; entity_id: string; changes: Record<string, unknown> }>(
      `SELECT action, actor_id, entity_type, entity_id, changes FROM eureka.audit_event WHERE action LIKE 'resume.%' ORDER BY seq`);
    const actions = new Set(rows.map((r) => r.action));
    expect([...actions].sort()).toEqual(["resume.downloaded", "resume.scanned", "resume.upload_requested"]);
    for (const r of rows) {
      expect(r.entity_type).toBe("resume");
      expect(r.entity_id).toMatch(/^[0-9a-f-]{36}$/);
      const allowed = { "resume.upload_requested": ["candidateId", "contentType", "sizeBytes"], "resume.downloaded": ["candidateId", "version"], "resume.scanned": ["result", "status"] }[r.action]!;
      expect(Object.keys(r.changes).sort()).toEqual(allowed);
      expect(JSON.stringify(r.changes)).not.toMatch(/Jane|Doe|\.pdf|@|\+1/);
    }
    expect(rows.filter((r) => r.action === "resume.scanned").every((r) => r.actor_id === null)).toBe(true);
    expect(rows.filter((r) => r.action !== "resume.scanned").every((r) => r.actor_id !== null)).toBe(true);
  });
});

describe("configuration", () => {
  const base = { NODE_ENV: "production", AUTH_MODE: "google", SESSION_SECRET: "x".repeat(40), DATABASE_URL: "postgres://x@y/z",
    GOOGLE_CLIENT_ID: "c", GOOGLE_CLIENT_SECRET: "s", GOOGLE_HOSTED_DOMAIN: "eureka.example", ORIGIN_VERIFY_SECRET: "o".repeat(40),
    AWS_REGION: "us-east-2", FIELD_KMS_KEY_ARN: "arn:aws:kms:us-east-2:123456789012:key/1234abcd-12ab-34cd-56ef-1234567890ab",
    BIDX_KMS_KEY_ARN: "arn:aws:kms:us-east-2:123456789012:key/9876abcd-12ab-34cd-56ef-1234567890ab" };
  it("production needs the documents bucket (no local driver)", () => {
    expect(() => loadConfig(base)).toThrow(/DOCUMENTS_BUCKET is required/);
    expect(loadConfig({ ...base, DOCUMENTS_BUCKET: "eureka-prod-documents" }).DOCUMENTS_BUCKET).toBe("eureka-prod-documents");
    expect(() => loadConfig({ ...base, DOCUMENTS_BUCKET: "b-1", LOCAL_STORAGE_DIR: "/tmp/x" })).toThrow(/only one/);
  });
  it("the worker refuses the fake scanner in production", () => {
    const w = { DATABASE_URL: "postgres://x@y/z", AUDIT_BUCKET: "a-1", NODE_ENV: "production",
      AWS_REGION: "us-east-2", FIELD_KMS_KEY_ARN: "arn:aws:kms:us-east-2:123456789012:key/1234abcd-12ab-34cd-56ef-1234567890ab" };
    expect(() => loadWorkerConfig({ ...w, LOCAL_STORAGE_DIR: "/tmp/x" })).toThrow(/not allowed in production/);
    expect(loadWorkerConfig({ ...w, DOCUMENTS_BUCKET: "d-1" }).RESUME_SCAN_TIMEOUT_MINUTES).toBe(60);
  });
});

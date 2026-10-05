import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { can } from "@eureka/shared";
import { createApp } from "../src/app.module.js";
import { loadConfig } from "../src/platform/config.js";
import { EICAR_TEST_STRING } from "../src/platform/storage/local-files.js";
import { LocalDocumentStore } from "../src/worker/document-store.js";
import { documentScanJob } from "../src/worker/jobs/document-scan.js";
import { DEFAULT_SCAN_OPTIONS } from "../src/worker/jobs/scan-pipeline.js";
import { silentLogger } from "../src/worker/log.js";
import { JobRunner } from "../src/worker/runner.js";
import { createTestDb, type TestDb } from "./db-harness.js";
import { LOC, U, seedFixtures, toUserAccess } from "./fixtures.js";

/**
 * DataHub end to end (docs/datahub-api.md) on the local document driver and
 * the fake scanner: folders with the three levels, the permission matrix for
 * every fixture user, validation, If-Match and Idempotency-Key, presigned
 * upload -> quarantine -> document-scan -> clean/ or restricted/ -> download,
 * versions, step-up for restricted downloads, the access log, search, members
 * and the people picker, deletes, and audit rows without names.
 */
let db: TestDb;
let app: NestFastifyApplication;
let dir: string;
const users = Object.keys(U) as (keyof typeof U)[];
const PDF = "application/pdf";
const adminUrl = new URL(process.env.TEST_PG_ADMIN_URL ?? "postgres://postgres:postgres@127.0.0.1:5432");

beforeAll(async () => {
  db = await createTestDb();
  await seedFixtures(db.admin);
  await db.admin.query(`INSERT INTO authz.policy_setting (key, value) VALUES ('dev_step_up', 'on')`);
  dir = await mkdtemp(join(tmpdir(), "eureka-datahub-"));
  app = await createApp(loadConfig({
    NODE_ENV: "test", AUTH_MODE: "dev", SESSION_SECRET: "test-secret-test-secret-test-secret-123",
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
async function login(key: string, fresh = false): Promise<Session> {
  const cached = sessions.get(key);
  if (cached && !fresh) return cached;
  const res = await app.inject({ method: "POST", url: "/api/auth/dev-login", payload: { email: `${key}@eureka.example` } });
  expect(res.statusCode).toBe(204);
  const cookie = String(res.headers["set-cookie"]).split(";")[0]!;
  const me = await app.inject({ method: "GET", url: "/api/v1/me", headers: { cookie } });
  const s = { cookie, csrf: me.json().csrfToken as string };
  if (!fresh) sessions.set(key, s);
  return s;
}
type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
async function call(who: string | Session, method: Method, url: string, payload?: unknown, headers: Record<string, string> = {}) {
  const s = typeof who === "string" ? await login(who) : who;
  return app.inject({
    method, url, payload: payload as never,
    headers: { cookie: s.cookie, ...(method !== "GET" ? { "x-csrf-token": s.csrf } : {}), ...headers },
  });
}

function form(fields: Record<string, string>, file: Buffer) {
  const b = "----eurekaDatahubBoundary";
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  parts.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="x"\r\nContent-Type: application/octet-stream\r\n\r\n`), file, Buffer.from(`\r\n--${b}--\r\n`));
  return { payload: Buffer.concat(parts), headers: { "content-type": `multipart/form-data; boundary=${b}` } };
}
const pdf = (text: string) => Buffer.from(`%PDF-1.7\n% fictional ${text}\n%%EOF\n`);
const runScan = async () => {
  await new JobRunner(db.worker, [documentScanJob(new LocalDocumentStore(dir), DEFAULT_SCAN_OPTIONS)], silentLogger).tick();
};
const exists = (p: string) => stat(p).then(() => true, () => false);

type Folder = { id: string; name: string; level: string; rowVersion: number; parentId: string | null; actions: Record<string, boolean>; memberCount: number | null; fileCount: number };
async function createFolder(who: string, body: Record<string, unknown>, status = 201): Promise<string> {
  const r = await call(who, "POST", "/api/v1/datahub/folders", body);
  expect(r.statusCode, r.body).toBe(status);
  return r.json().id as string;
}
async function upload(who: string, folderId: string, name: string, body: Buffer, contentType = PDF) {
  const r = await call(who, "POST", `/api/v1/datahub/folders/${folderId}/files`, { name, contentType, size: body.length });
  expect(r.statusCode, r.body).toBe(201);
  const out = r.json() as { fileId: string; versionId: string; version: number; status: string; upload: { url: string; fields: Record<string, string> } };
  const up = await app.inject({ method: "POST", url: out.upload.url, ...form(out.upload.fields, body) });
  expect(up.statusCode, up.body).toBe(204);
  return out;
}
const folderList = async (who: string) => {
  const r = await call(who, "GET", "/api/v1/datahub/folders");
  expect(r.statusCode, r.body).toBe(200);
  return r.json() as { items: Folder[]; canCreate: boolean; createScope: { org: boolean; locationIds: string[] } };
};
const fileList = async (who: string, folderId: string) => {
  const r = await call(who, "GET", `/api/v1/datahub/folders/${folderId}/files`);
  expect(r.statusCode, r.body).toBe(200);
  return r.json() as { items: { id: string; name: string; versionCount: number; latestVersion: { id: string; version: number; status: string; reason: string | null }; actions: { download: boolean; delete: boolean } }[]; nextCursor: string | null };
};
const getUrl = async (url: string) => app.inject({ method: "GET", url });

const F: Record<string, string> = {};

describe("folders", () => {
  it("navigation: every staff role holds datahub:read; org_admin and the API agree", async () => {
    for (const key of users) {
      const me = (await call(key, "GET", "/api/v1/me")).json() as { capabilities: string[] };
      expect(me.capabilities.includes("datahub:read"), key).toBe(can(toUserAccess(key), "datahub:read"));
      const r = await call(key, "GET", "/api/v1/datahub/folders");
      expect(r.statusCode, key).toBe(can(toUserAccess(key), "datahub:read") ? 200 : 403);
    }
    expect((await call("admin", "GET", "/api/v1/datahub/folders")).statusCode).toBe(403);
  });

  it("creates folders with the reference dialog's fields; managers only", async () => {
    F.internal = await createFolder("hr", { name: "Java Resumes", level: "internal", description: "Templates and samples", membersCanUpload: true });
    F.confidential = await createFolder("hr", { name: "Sales playbooks", level: "confidential", roleKeys: ["lead", "manager"] });
    F.restricted = await createFolder("acct", { name: "Payroll exports", level: "restricted", memberIds: [U.r1a, U.acct] });
    F.dallas = await createFolder("locD", { name: "Dallas guest house", level: "internal", locationId: LOC.dallas });
    F.sub = await createFolder("hr", { name: "2026", level: "internal", parentId: F.internal, membersCanUpload: true });
    expect((await call("r1a", "POST", "/api/v1/datahub/folders", { name: "x", level: "internal" })).statusCode).toBe(403);
    expect((await call("locD", "POST", "/api/v1/datahub/folders", { name: "x", level: "internal", locationId: LOC.austin })).statusCode).toBe(403);
    const noLoc = await call("locD", "POST", "/api/v1/datahub/folders", { name: "x", level: "internal" });
    expect(noLoc.statusCode).toBe(422);
    expect(noLoc.json().detail).toBe("location_required");
    const dup = await call("hr", "POST", "/api/v1/datahub/folders", { name: "  java resumes ", level: "internal" });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().detail).toBe("name_taken");
    const deep = await call("hr", "POST", "/api/v1/datahub/folders", { name: "deep", level: "internal", parentId: F.sub });
    expect(deep.json().detail).toBe("too_deep");
  });

  it.each([
    [{ name: "", level: "internal" }],
    [{ name: "a/b", level: "internal" }],
    [{ name: "x", level: "top_secret" }],
    [{ name: "x", level: "confidential" }],
    [{ name: "x", level: "confidential", roleKeys: [] }],
    [{ name: "x", level: "confidential", roleKeys: ["wizard"] }],
    [{ name: "x", level: "confidential", roleKeys: ["hr", "hr"] }],
    [{ name: "x", level: "internal", roleKeys: ["hr"] }],
    [{ name: "x", level: "internal", memberIds: [U.r1a] }],
    [{ name: "x", level: "restricted", memberIds: ["not-a-uuid"] }],
    [{ name: "x", level: "internal", description: "d".repeat(501) }],
    [{ name: "x", level: "internal", ownerId: U.hr }],
    [{ name: "x", level: "internal", rowVersion: 9 }],
  ])("rejects %j with 422", async (body) => {
    expect((await call("hr", "POST", "/api/v1/datahub/folders", body)).statusCode).toBe(422);
  });

  it("a restricted member who is not staff (org_admin) is refused", async () => {
    const r = await call("hr", "POST", "/api/v1/datahub/folders", { name: "x", level: "restricted", memberIds: [U.admin] });
    expect(r.statusCode).toBe(422);
    expect(r.json().detail).toBe("invalid_member");
  });

  it("Idempotency-Key: a retry returns the first answer; a different body is a conflict", async () => {
    const body = { name: "Retry me", level: "internal" };
    const a = await call("hr", "POST", "/api/v1/datahub/folders", body, { "idempotency-key": "dh-retry-1" });
    const b = await call("hr", "POST", "/api/v1/datahub/folders", body, { "idempotency-key": "dh-retry-1" });
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);
    expect(b.json()).toEqual(a.json());
    const c = await call("hr", "POST", "/api/v1/datahub/folders", { ...body, name: "Other" }, { "idempotency-key": "dh-retry-1" });
    expect(c.statusCode).toBe(409);
  });

  it("the folder panel per user: readable and managed folders with their actions", async () => {
    const r1a = await folderList("r1a");
    const names = r1a.items.map((f) => f.name);
    expect(names).toEqual(expect.arrayContaining(["Java Resumes", "Payroll exports", "2026", "Dallas guest house"]));
    expect(names).not.toContain("Sales playbooks");
    expect(r1a.canCreate).toBe(false);
    expect(r1a.items.find((f) => f.id === F.internal)!.actions).toMatchObject({ read: true, upload: true, manage: false });
    expect(r1a.items.find((f) => f.id === F.dallas)!.actions).toMatchObject({ read: true, upload: false, manage: false });

    const l1 = await folderList("l1");
    expect(l1.items.map((f) => f.name)).toContain("Sales playbooks");
    expect(l1.items.map((f) => f.name)).not.toContain("Payroll exports");

    // HR manages every folder: sees the restricted one (settings, members) but cannot read its files.
    const hr = await folderList("hr");
    const pay = hr.items.find((f) => f.id === F.restricted)!;
    expect(pay.actions).toMatchObject({ read: false, upload: false, manage: true });
    expect(pay.memberCount).toBe(2);
    expect(hr.createScope).toEqual({ org: true, locationIds: [] });
    expect((await call("hr", "GET", `/api/v1/datahub/folders/${F.restricted}/files`)).json().detail).toBe("not_member");

    const locD = await folderList("locD");
    expect(locD.createScope).toEqual({ org: false, locationIds: [LOC.dallas] });
    expect(locD.items.find((f) => f.id === F.dallas)!.actions.manage).toBe(true);
    expect(locD.items.find((f) => f.id === F.internal)!.actions.manage).toBe(false);

    expect((await call("r2a", "GET", `/api/v1/datahub/folders/${F.restricted}`)).statusCode).toBe(404);
    expect((await call("r2a", "GET", `/api/v1/datahub/folders/${F.restricted}/files`)).statusCode).toBe(404);
  });

  it("PATCH: If-Match required (428), stale (412), managers only (403), then applied", async () => {
    const url = `/api/v1/datahub/folders/${F.confidential}`;
    expect((await call("hr", "PATCH", url, { description: "x" })).statusCode).toBe(428);
    expect((await call("hr", "PATCH", url, { description: "x" }, { "if-match": '"7"' })).statusCode).toBe(412);
    expect((await call("l1", "PATCH", url, { description: "x" }, { "if-match": '"1"' })).statusCode).toBe(403);
    expect((await call("r1a", "PATCH", url, { description: "x" }, { "if-match": '"1"' })).statusCode).toBe(404);
    expect((await call("hr", "PATCH", url, {}, { "if-match": '"1"' })).statusCode).toBe(422);
    expect((await call("hr", "PATCH", url, { roleKeys: ["lead"], level: "internal" }, { "if-match": '"1"' })).statusCode).toBe(422);
    const ok = await call("hr", "PATCH", url, { description: "Decks for leads and managers", roleKeys: ["lead", "manager", "assoc_director"] }, { "if-match": '"1"' });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toEqual({ id: F.confidential, rowVersion: 2 });
    const f = (await call("ad", "GET", url)).json();
    expect(f).toMatchObject({ description: "Decks for leads and managers", roleKeys: ["lead", "manager", "assoc_director"], rowVersion: 2 });
  });

  it("members and the people picker (managers only)", async () => {
    const people = await call("hr", "GET", "/api/v1/datahub/people?q=r1");
    expect(people.statusCode).toBe(200);
    expect(people.json().items.map((p: { name: string }) => p.name)).toEqual(["r1a", "r1b"]);
    expect((await call("hr", "GET", "/api/v1/datahub/people")).json().items.map((p: { id: string }) => p.id)).not.toContain(U.admin);
    expect((await call("r1a", "GET", "/api/v1/datahub/people")).statusCode).toBe(403);

    const url = `/api/v1/datahub/folders/${F.restricted}/members`;
    expect((await call("r1a", "GET", url)).statusCode).toBe(403);
    expect((await call("hr", "PUT", `${url}/${U.r2a}`)).statusCode).toBe(204);
    expect((await call("hr", "GET", url)).json().items.map((m: { id: string }) => m.id).sort()).toEqual([U.r1a, U.r2a, U.acct].sort());
    expect((await call("hr", "DELETE", `${url}/${U.r2a}`)).statusCode).toBe(204);
    expect((await call("hr", "PUT", `/api/v1/datahub/folders/${F.internal}/members/${U.r2a}`)).json().detail).toBe("not_restricted");
    expect((await call("r1a", "PUT", `${url}/${U.r2a}`)).statusCode).toBe(403);
  });
});

describe("files", () => {
  it("upload -> scan -> list; re-uploading the same name adds a version; downloads carry a safe name", async () => {
    const v1 = await upload("r1b", F.internal, "Leave policy.pdf", pdf("leave v1"));
    expect(v1).toMatchObject({ version: 1, status: "pending" });
    expect(v1.upload.fields.key).toBe(`quarantine/documents/${(await db.admin.query(`SELECT file_object_id FROM eureka.datahub_file_version WHERE id = $1`, [v1.versionId])).rows[0].file_object_id}`);
    let list = await fileList("r1a", F.internal);
    expect(list.items[0]).toMatchObject({ name: "Leave policy.pdf", latestVersion: { status: "pending" }, actions: { download: false, delete: false } });
    await runScan();
    const v2 = await upload("hr", F.internal, "leave policy.PDF", pdf("leave v2"));
    expect(v2).toMatchObject({ fileId: v1.fileId, version: 2 });
    await runScan();
    list = await fileList("r1b", F.internal);
    expect(list.items[0]).toMatchObject({ id: v1.fileId, versionCount: 2, latestVersion: { version: 2, status: "clean" }, actions: { download: true, delete: false } });
    const versions = (await call("r1a", "GET", `/api/v1/datahub/files/${v1.fileId}/versions`)).json().items;
    expect(versions.map((v: { version: number; status: string }) => [v.version, v.status])).toEqual([[2, "clean"], [1, "clean"]]);

    const d = await call("r1a", "POST", `/api/v1/datahub/versions/${v1.versionId}/download`);
    expect(d.statusCode, d.body).toBe(200);
    const got = await getUrl(d.json().url);
    expect(got.statusCode).toBe(200);
    expect(got.rawPayload.equals(pdf("leave v1"))).toBe(true);
    expect(String(got.headers["content-disposition"])).toBe('attachment; filename="Leave-policy-v1.pdf"');
  });

  it("upload rules: members-can-upload off -> 403 for readers; name and type checked (422); not visible -> 404", async () => {
    expect((await call("r1a", "POST", `/api/v1/datahub/folders/${F.dallas}/files`, { name: "a.pdf", contentType: PDF, size: 10 })).statusCode).toBe(403);
    expect((await call("l1", "POST", `/api/v1/datahub/folders/${F.restricted}/files`, { name: "a.pdf", contentType: PDF, size: 10 })).statusCode).toBe(404);
    for (const body of [
      { name: "a.exe", contentType: PDF, size: 10 },
      { name: "a/b.pdf", contentType: PDF, size: 10 },
      { name: "a.pdf", contentType: "text/html", size: 10 },
      { name: "a.pdf", contentType: PDF, size: 0 },
      { name: "a.pdf", contentType: PDF, size: 15 * 1024 * 1024 + 1 },
      { name: "a.pdf", contentType: PDF, size: 10, folderId: F.restricted },
    ]) expect((await call("hr", "POST", `/api/v1/datahub/folders/${F.internal}/files`, body)).statusCode, JSON.stringify(body)).toBe(422);
  });

  it("an infected upload is never downloadable", async () => {
    const bad = await upload("hr", F.internal, "Virus.pdf", pdf(EICAR_TEST_STRING));
    await runScan();
    const row = (await fileList("hr", F.internal)).items.find((f) => f.id === bad.fileId)!;
    expect(row.latestVersion).toMatchObject({ status: "infected", reason: "THREATS_FOUND" });
    const d = await call("hr", "POST", `/api/v1/datahub/versions/${bad.versionId}/download`);
    expect(d.statusCode).toBe(409);
    expect(d.json().detail).toBe("not_available");
  });

  it("restricted: stored under restricted/, every download needs a step-up and is in the managers' access log", async () => {
    const up = await upload("acct", F.restricted, "June payroll.pdf", pdf("june"));
    await runScan();
    const fo = (await db.admin.query(`SELECT file_object_id FROM eureka.datahub_file_version WHERE id = $1`, [up.versionId])).rows[0].file_object_id;
    expect(await exists(join(dir, "restricted/documents", fo))).toBe(true);
    expect(await exists(join(dir, "clean/documents", fo))).toBe(false);

    const s = await login("r1a", true);
    const before = await call(s, "POST", `/api/v1/datahub/versions/${up.versionId}/download`);
    expect(before.statusCode).toBe(403);
    expect(before.json().detail).toBe("step_up_required");
    expect((await call(s, "POST", "/api/auth/step-up/dev")).statusCode).toBe(200);
    const after = await call(s, "POST", `/api/v1/datahub/versions/${up.versionId}/download`);
    expect(after.statusCode, after.body).toBe(200);
    expect((await getUrl(after.json().url)).rawPayload.equals(pdf("june"))).toBe(true);
    // Not a member: not found, with or without a step-up.
    expect((await call("r2a", "POST", `/api/v1/datahub/versions/${up.versionId}/download`)).statusCode).toBe(404);

    const log = await call("hr", "GET", `/api/v1/datahub/folders/${F.restricted}/access-log`);
    expect(log.statusCode).toBe(200);
    const items = log.json().items as { user: { id: string }; fileName: string | null; version: number; level: string; steppedUp: boolean }[];
    expect(items).toHaveLength(1);
    // HR manages the folder but is not a member: ids, not the file name.
    expect(items[0]).toMatchObject({ user: { id: U.r1a }, fileName: null, version: 1, level: "restricted", steppedUp: true });
    expect((await call("acct", "GET", `/api/v1/datahub/folders/${F.restricted}/access-log`)).json().items[0].fileName).toBe("June payroll.pdf");
    expect((await call("r1a", "GET", `/api/v1/datahub/folders/${F.restricted}/access-log`)).statusCode).toBe(403);
  });

  it("search: file and folder names over readable folders only", async () => {
    const r = await call("r1a", "GET", "/api/v1/datahub/search?q=PAY");
    expect(r.statusCode).toBe(200);
    expect(r.json().folders.map((f: { name: string }) => f.name)).toEqual(["Payroll exports"]);
    expect(r.json().files.map((f: { name: string; folderName: string }) => [f.name, f.folderName])).toEqual([["June payroll.pdf", "Payroll exports"]]);
    expect((await call("r2a", "GET", "/api/v1/datahub/search?q=pay")).json()).toEqual({ folders: [], files: [] });
    expect((await call("hr", "GET", "/api/v1/datahub/search?q=june")).json().files).toEqual([]);
    expect((await call("r1a", "GET", "/api/v1/datahub/search?q=leave")).json().files[0]).toMatchObject({ name: "Leave policy.pdf", latestVersion: { version: 2 } });
    // LIKE wildcards are literal.
    expect((await call("r1a", "GET", "/api/v1/datahub/search?q=%25")).json()).toEqual({ folders: [], files: [] });
    expect((await call("r1a", "GET", "/api/v1/datahub/search?q=")).statusCode).toBe(422);
  });

  it("delete: uploader of every version or a manager; then the empty folder can go", async () => {
    const mine = await upload("r1a", F.sub, "Mine.pdf", pdf("mine"));
    expect((await call("r1b", "DELETE", `/api/v1/datahub/files/${mine.fileId}`)).statusCode).toBe(403);
    const folder = (await call("hr", "GET", `/api/v1/datahub/folders/${F.sub}`)).json() as Folder;
    const notEmpty = await call("hr", "DELETE", `/api/v1/datahub/folders/${F.sub}`, undefined, { "if-match": `"${folder.rowVersion}"` });
    expect(notEmpty.statusCode).toBe(409);
    expect(notEmpty.json().detail).toBe("folder_not_empty");
    expect((await call("r1a", "DELETE", `/api/v1/datahub/files/${mine.fileId}`)).statusCode).toBe(204);
    expect((await call("r1a", "DELETE", `/api/v1/datahub/files/${mine.fileId}`)).statusCode).toBe(404);
    expect((await call("hr", "DELETE", `/api/v1/datahub/folders/${F.sub}`)).statusCode).toBe(428);
    expect((await call("r1a", "DELETE", `/api/v1/datahub/folders/${F.sub}`, undefined, { "if-match": `"${folder.rowVersion}"` })).statusCode).toBe(403);
    expect((await call("hr", "DELETE", `/api/v1/datahub/folders/${F.sub}`, undefined, { "if-match": `"${folder.rowVersion}"` })).statusCode).toBe(204);
    expect((await call("hr", "GET", `/api/v1/datahub/folders/${F.sub}`)).statusCode).toBe(404);
  });

  it("file lists page by name with a cursor", async () => {
    const id = await createFolder("hr", { name: "Paged", level: "internal" });
    for (const n of ["c.pdf", "a.pdf", "b.pdf"]) await call("hr", "POST", `/api/v1/datahub/folders/${id}/files`, { name: n, contentType: PDF, size: 5 });
    const p1 = await call("hr", "GET", `/api/v1/datahub/folders/${id}/files?limit=2`);
    expect(p1.json().items.map((f: { name: string }) => f.name)).toEqual(["a.pdf", "b.pdf"]);
    const p2 = await call("hr", "GET", `/api/v1/datahub/folders/${id}/files?limit=2&cursor=${p1.json().nextCursor}`);
    expect(p2.json()).toMatchObject({ items: [{ name: "c.pdf" }], nextCursor: null });
    expect((await call("hr", "GET", `/api/v1/datahub/folders/${id}/files?cursor=bogus`)).statusCode).toBe(422);
  });
});

describe("audit (rule 5)", () => {
  it("no folder names, file names or descriptions in audit rows", async () => {
    const rows = (await db.admin.query(`SELECT action, changes FROM eureka.audit_event WHERE action LIKE 'datahub.%'`)).rows;
    expect(rows.length).toBeGreaterThan(10);
    const text = JSON.stringify(rows);
    for (const s of ["Java Resumes", "Sales playbooks", "Payroll", "Dallas guest house", "Templates and samples", "Decks for", "Leave", "June", "Virus", "Mine"]) {
      expect(text, s).not.toContain(s);
    }
  });

  it("the stored file is never readable before the scan, and the bytes on disk match", async () => {
    const up = await upload("hr", F.internal, "Raw.pdf", pdf("raw"));
    const fo = (await db.admin.query(`SELECT file_object_id FROM eureka.datahub_file_version WHERE id = $1`, [up.versionId])).rows[0].file_object_id;
    expect((await call("hr", "POST", `/api/v1/datahub/versions/${up.versionId}/download`)).statusCode).toBe(409);
    await runScan();
    expect(await readFile(join(dir, "clean/documents", fo))).toEqual(pdf("raw"));
  });
});

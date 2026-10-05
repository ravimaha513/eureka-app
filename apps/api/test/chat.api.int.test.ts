import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.module.js";
import { loadConfig } from "../src/platform/config.js";
import { EICAR_TEST_STRING } from "../src/platform/storage/local-files.js";
import { LocalDocumentStore } from "../src/worker/document-store.js";
import { documentScanJob } from "../src/worker/jobs/document-scan.js";
import { DEFAULT_SCAN_OPTIONS } from "../src/worker/jobs/scan-pipeline.js";
import { silentLogger } from "../src/worker/log.js";
import { JobRunner } from "../src/worker/runner.js";
import { createTestDb, type TestDb } from "./db-harness.js";
import { U, seedFixtures } from "./fixtures.js";

/**
 * Chat API (docs/chat-api.md): conversations, messages with polling cursors,
 * attachments through the documents pipeline (local driver, fake scanner),
 * read marks and unread counts, group management with If-Match, presence,
 * the people picker, validation and scope (404 for non-members).
 */
let db: TestDb;
let app: NestFastifyApplication;
let dir: string;
const adminUrl = new URL(process.env.TEST_PG_ADMIN_URL ?? "postgres://postgres:postgres@127.0.0.1:5432");
type Key = keyof typeof U | "norole";

beforeAll(async () => {
  db = await createTestDb();
  await seedFixtures(db.admin);
  await db.admin.query(`UPDATE eureka.app_user SET designation = 'HR Executive' WHERE id = $1`, [U.hr]);
  await db.admin.query(`INSERT INTO eureka.app_user (email, display_name) VALUES ('norole@eureka.example', 'No Role')`);
  dir = await mkdtemp(join(tmpdir(), "eureka-chat-"));
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

const sessions = new Map<string, { cookie: string; csrf: string }>();
async function login(key: Key) {
  const cached = sessions.get(key);
  if (cached) return cached;
  const res = await app.inject({ method: "POST", url: "/api/auth/dev-login", payload: { email: `${key}@eureka.example` } });
  expect(res.statusCode, res.body).toBe(204);
  const cookie = String(res.headers["set-cookie"]).split(";")[0]!;
  const me = await app.inject({ method: "GET", url: "/api/v1/me", headers: { cookie } });
  const s = { cookie, csrf: me.json().csrfToken as string };
  sessions.set(key, s);
  return s;
}
type Method = "GET" | "POST" | "PATCH" | "DELETE";
async function call(key: Key, method: Method, url: string, payload?: unknown, headers: Record<string, string> = {}) {
  const s = await login(key);
  return app.inject({ method, url, payload: payload as never,
    headers: { cookie: s.cookie, ...(method !== "GET" ? { "x-csrf-token": s.csrf } : {}), ...headers } });
}
async function ok<T = any>(key: Key, method: Method, url: string, payload?: unknown, status = 200, headers: Record<string, string> = {}): Promise<T> {
  const r = await call(key, method, url, payload, headers);
  expect(r.statusCode, `${method} ${url}: ${r.body}`).toBe(status);
  return (r.body ? r.json() : undefined) as T;
}
const C = "/api/v1/chat";
const openDirect = (a: Key, b: string, status = 201) => ok(a, "POST", `${C}/conversations/direct`, { userId: b }, status);
const send = (who: Key, conv: string, body: string, extra: Record<string, unknown> = {}) =>
  ok(who, "POST", `${C}/conversations/${conv}/messages`, { clientId: randomUUID(), body, ...extra }, 201);

function form(fields: Record<string, string>, file: Buffer) {
  const b = "----eurekaChatBoundary";
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  parts.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="x"\r\nContent-Type: application/octet-stream\r\n\r\n`), file, Buffer.from(`\r\n--${b}--\r\n`));
  return { payload: Buffer.concat(parts), headers: { "content-type": `multipart/form-data; boundary=${b}` } };
}
const runScan = () => new JobRunner(db.worker, [documentScanJob(new LocalDocumentStore(dir), DEFAULT_SCAN_OPTIONS)], silentLogger).tick();

describe("chat API", () => {
  it("needs chat:use, a session and the CSRF token", async () => {
    expect((await call("norole", "GET", `${C}/conversations`)).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: `${C}/conversations` })).statusCode).toBe(401);
    const s = await login("r1a");
    const r = await app.inject({ method: "POST", url: `${C}/conversations/direct`, payload: { userId: U.hr }, headers: { cookie: s.cookie } });
    expect(r.statusCode).toBe(403);
    // Org admins chat too (own conversations only).
    expect((await call("admin", "GET", `${C}/conversations`)).statusCode).toBe(200);
  });

  it("direct chat: open, send, poll, unread, read, edit, delete, hide", async () => {
    const conv = await openDirect("r1a", U.hr);
    expect(conv).toMatchObject({ kind: "direct", title: "hr", canManage: false });
    expect(conv.members.map((m: { id: string }) => m.id).sort()).toEqual([U.r1a, U.hr].sort());
    expect((await openDirect("hr", U.r1a, 200)).id).toBe(conv.id);

    const first = await ok("hr", "GET", `${C}/conversations/${conv.id}/messages`);
    expect(first.items).toEqual([]);
    const cursor0 = first.cursor as number;

    const sent = await send("r1a", conv.id, "Hello\r\nsee https://example.com/x  ");
    expect(sent.message).toMatchObject({ body: "Hello\nsee https://example.com/x", mine: true, deleted: false, attachments: [] });
    expect(sent.uploads).toEqual([]);
    const polled = await ok("hr", "GET", `${C}/conversations/${conv.id}/messages?after=${cursor0}`);
    expect(polled.items.map((m: { body: string; mine: boolean }) => [m.body, m.mine])).toEqual([["Hello\nsee https://example.com/x", false]]);
    expect(polled.cursor).toBeGreaterThan(cursor0);
    expect(polled.more).toBe(false);
    expect(await ok("hr", "GET", `${C}/unread`)).toEqual({ unread: 1, capped: false, conversations: 1 });
    expect(await ok("r1a", "GET", `${C}/unread`)).toEqual({ unread: 0, capped: false, conversations: 0 });
    const listed = (await ok("hr", "GET", `${C}/conversations`)).items.find((c: { id: string }) => c.id === conv.id);
    expect(listed).toMatchObject({ kind: "direct", title: "r1a", unread: 1, lastMessage: { preview: "Hello see https://example.com/x", mine: false } });
    expect(listed.counterpart).toMatchObject({ id: U.r1a, online: true }); // r1a has a live session
    await ok("hr", "POST", `${C}/conversations/${conv.id}/read`, {}, 204);
    expect((await ok("hr", "GET", `${C}/unread`)).unread).toBe(0);

    // Edits and deletes come back through the poll cursor.
    const edited = await ok("r1a", "PATCH", `${C}/messages/${sent.message.id}`, { body: "Hello again" });
    expect(edited).toMatchObject({ body: "Hello again" });
    expect(edited.editedAt).not.toBeNull();
    expect((await call("hr", "PATCH", `${C}/messages/${sent.message.id}`, { body: "not mine" })).statusCode).toBe(403);
    await ok("r1a", "DELETE", `${C}/messages/${sent.message.id}`, undefined, 204);
    const changes = await ok("hr", "GET", `${C}/conversations/${conv.id}/messages?after=${polled.cursor}`);
    expect(changes.items).toEqual([expect.objectContaining({ id: sent.message.id, deleted: true, body: "" })]);
    const list2 = (await ok("hr", "GET", `${C}/conversations`)).items.find((c: { id: string }) => c.id === conv.id);
    expect(list2.lastMessage.preview).toBe("Message deleted");

    // Idempotent send: same clientId -> 200 with the first message.
    const clientId = randomUUID();
    const a = await ok("r1a", "POST", `${C}/conversations/${conv.id}/messages`, { clientId, body: "once" }, 201);
    const b = await ok("r1a", "POST", `${C}/conversations/${conv.id}/messages`, { clientId, body: "once" }, 200);
    expect(b.message.id).toBe(a.message.id);

    // "Delete chat" of a direct chat hides it for hr only.
    await ok("hr", "DELETE", `${C}/conversations/${conv.id}`, undefined, 204);
    expect((await ok("hr", "GET", `${C}/conversations`)).items.map((c: { id: string }) => c.id)).not.toContain(conv.id);
    expect((await ok("r1a", "GET", `${C}/conversations/${conv.id}/messages`)).items.length).toBeGreaterThan(0);
    const reopened = await openDirect("hr", U.r1a, 200);
    expect(reopened.id).toBe(conv.id);
    expect((await ok("hr", "GET", `${C}/conversations/${conv.id}/messages`)).items).toEqual([]);
  });

  it("non-members get 404 everywhere", async () => {
    const conv = await openDirect("l1", U.l2);
    const m = await send("l1", conv.id, "private");
    for (const [method, url, body] of [
      ["GET", `${C}/conversations/${conv.id}`, undefined],
      ["GET", `${C}/conversations/${conv.id}/messages`, undefined],
      ["POST", `${C}/conversations/${conv.id}/messages`, { clientId: randomUUID(), body: "x" }],
      ["POST", `${C}/conversations/${conv.id}/read`, {}],
      ["PATCH", `${C}/conversations/${conv.id}/preferences`, { favorite: true }],
      ["DELETE", `${C}/conversations/${conv.id}`, undefined],
      ["PATCH", `${C}/messages/${m.message.id}`, { body: "x" }],
      ["DELETE", `${C}/messages/${m.message.id}`, undefined],
    ] as [Method, string, unknown][]) {
      for (const who of ["r1a", "admin", "ceo"] as const) {
        expect((await call(who, method, url, body)).statusCode, `${who} ${method} ${url}`).toBe(404);
      }
    }
  });

  it("validates input (422) and ids (400)", async () => {
    const conv = await openDirect("r1b", U.l1);
    const post = (body: unknown) => call("r1b", "POST", `${C}/conversations/${conv.id}/messages`, body);
    expect((await post({ clientId: randomUUID(), body: "   " })).statusCode).toBe(422);
    expect((await post({ clientId: randomUUID(), body: "x".repeat(4001) })).statusCode).toBe(422);
    expect((await post({ clientId: randomUUID(), body: "bell\u0007" })).statusCode).toBe(422);
    expect((await post({ body: "no client id" })).statusCode).toBe(422);
    expect((await post({ clientId: randomUUID(), body: "x", senderId: U.ceo })).statusCode).toBe(422);
    expect((await post({ clientId: randomUUID(), attachments: [{ fileName: "a.exe", contentType: "application/x-msdownload", size: 10 }] })).statusCode).toBe(422);
    expect((await post({ clientId: randomUUID(), attachments: [{ fileName: "a.pdf", contentType: "application/pdf", size: 16 * 1024 * 1024 }] })).statusCode).toBe(422);
    expect((await post({ clientId: randomUUID(), attachments: Array(6).fill({ fileName: "a.pdf", contentType: "application/pdf", size: 10 }) })).statusCode).toBe(422);
    expect((await call("r1b", "POST", `${C}/conversations/group`, { name: "", memberIds: [U.l1] })).statusCode).toBe(422);
    expect((await call("r1b", "POST", `${C}/conversations/group`, { name: "G", memberIds: [] })).statusCode).toBe(422);
    expect((await call("r1b", "POST", `${C}/conversations/group`, { name: "G", memberIds: [randomUUID()] })).json().detail).toBe("invalid_member");
    expect((await call("r1b", "POST", `${C}/conversations/direct`, { userId: U.r1b })).json().detail).toBe("invalid_member");
    expect((await call("r1b", "GET", `${C}/conversations/not-a-uuid`)).statusCode).toBe(400);
    expect((await call("r1b", "GET", `${C}/conversations?filter=spam`)).statusCode).toBe(422);
    expect((await call("r1b", "GET", `${C}/conversations?cursor=bogus`)).statusCode).toBe(422);
    expect((await call("r1b", "GET", `${C}/conversations/${conv.id}/messages?before=5&after=3`)).statusCode).toBe(422);
    expect((await call("r1b", "PATCH", `${C}/conversations/${conv.id}/preferences`, {})).statusCode).toBe(422);
  });

  it("groups: create, rename with If-Match, members and roles, leave, delete for everyone", async () => {
    const g = await ok("m1", "POST", `${C}/conversations/group`, { name: "  Pipeline review  ", memberIds: [U.l1, U.l2] }, 201);
    expect(g).toMatchObject({ kind: "group", title: "Pipeline review", canManage: true, myRole: "owner", rowVersion: 1 });
    expect(g.members).toHaveLength(3);
    expect((await ok("l1", "GET", `${C}/conversations/${g.id}`)).canManage).toBe(false);

    expect((await call("m1", "PATCH", `${C}/conversations/${g.id}`, { name: "Renamed" })).statusCode).toBe(428);
    expect((await call("m1", "PATCH", `${C}/conversations/${g.id}`, { name: "Renamed" }, { "if-match": '"9"' })).statusCode).toBe(412);
    expect((await call("l1", "PATCH", `${C}/conversations/${g.id}`, { name: "Mine" }, { "if-match": '"1"' })).statusCode).toBe(403);
    const renamed = await ok("m1", "PATCH", `${C}/conversations/${g.id}`, { name: "Renamed" }, 200, { "if-match": '"1"' });
    expect(renamed).toMatchObject({ title: "Renamed", rowVersion: 2 });

    const added = await ok("m1", "POST", `${C}/conversations/${g.id}/members`, { userIds: [U.r1a, U.l1] });
    expect(added.added).toBe(1);
    expect(added.conversation.members).toHaveLength(4);
    expect((await call("l1", "POST", `${C}/conversations/${g.id}/members`, { userIds: [U.r1b] })).statusCode).toBe(403);
    await ok("m1", "DELETE", `${C}/conversations/${g.id}/members/${U.r1a}`, undefined, 204);
    expect((await call("r1a", "GET", `${C}/conversations/${g.id}`)).statusCode).toBe(404);
    expect((await call("m1", "PATCH", `${C}/conversations/${g.id}/members/${U.m1}`, { role: "member" })).json().detail).toBe("last_owner");
    const promoted = await ok("m1", "PATCH", `${C}/conversations/${g.id}/members/${U.l1}`, { role: "owner" });
    expect(promoted.members.find((m: { id: string }) => m.id === U.l1).role).toBe("owner");

    await send("l2", g.id, "group hello");
    const groups = (await ok("l2", "GET", `${C}/conversations?filter=group`)).items;
    expect(groups.map((c: { id: string }) => c.id)).toContain(g.id);
    expect((await ok("l2", "GET", `${C}/conversations?q=renam`)).items.map((c: { id: string }) => c.id)).toEqual([g.id]);
    expect((await ok("l2", "GET", `${C}/conversations?q=%25`)).items).toEqual([]);

    await ok("l2", "POST", `${C}/conversations/${g.id}/leave`, undefined, 204);
    expect((await call("l2", "GET", `${C}/conversations/${g.id}/messages`)).statusCode).toBe(404);
    expect((await call("l1", "DELETE", `${C}/conversations/${g.id}`)).statusCode).toBe(204); // l1 is an owner now
    expect((await call("m1", "GET", `${C}/conversations/${g.id}`)).statusCode).toBe(404);
  });

  it("preferences drive the filters; muted chats leave the badge", async () => {
    const conv = await openDirect("locD", U.locA);
    await send("locA", conv.id, "ping");
    const ids = async (filter: string) => (await ok("locD", "GET", `${C}/conversations?filter=${filter}`)).items.map((c: { id: string }) => c.id);
    expect(await ids("unread")).toContain(conv.id);
    expect(await ok("locD", "PATCH", `${C}/conversations/${conv.id}/preferences`, { favorite: true })).toEqual({ archived: false, favorite: true, muted: false });
    expect(await ids("favorite")).toEqual([conv.id]);
    await ok("locD", "PATCH", `${C}/conversations/${conv.id}/preferences`, { archived: true });
    expect(await ids("all")).not.toContain(conv.id);
    expect(await ids("archived")).toEqual([conv.id]);
    expect((await ok("locD", "GET", `${C}/unread`)).unread).toBe(1);
    await ok("locD", "PATCH", `${C}/conversations/${conv.id}/preferences`, { muted: true });
    expect((await ok("locD", "GET", `${C}/unread`)).unread).toBe(0);
  });

  it("history pages and the people picker (name and designation only; presence)", async () => {
    const conv = await openDirect("r2a", U.l2);
    for (let i = 0; i < 7; i++) await send("r2a", conv.id, `m${i}`);
    const p1 = await ok("l2", "GET", `${C}/conversations/${conv.id}/messages?limit=3`);
    expect(p1.items.map((m: { body: string }) => m.body)).toEqual(["m4", "m5", "m6"]);
    const p2 = await ok("l2", "GET", `${C}/conversations/${conv.id}/messages?limit=3&before=${p1.nextCursor}`);
    expect(p2.items.map((m: { body: string }) => m.body)).toEqual(["m1", "m2", "m3"]);

    const people = await ok("r2a", "GET", `${C}/people?q=hr`);
    expect(people.items).toEqual([{ id: U.hr, name: "hr", designation: "HR Executive", online: true }]);
    const everyone = (await ok("r2a", "GET", `${C}/people?limit=50`)).items as { id: string; online: boolean }[];
    expect(everyone.map((p) => p.id)).not.toContain(U.r2a);
    expect(everyone.find((p) => p.id === U.imm)?.online).toBe(false); // never signed in
    expect(Object.keys(everyone[0]!).sort()).toEqual(["designation", "id", "name", "online"]);
  });

  it("attachments: presigned upload, scan, download when clean; blocked files never open", async () => {
    const conv = await openDirect("acct", U.hr);
    const pdf = Buffer.from("%PDF-1.7\n% fictional chat attachment\n%%EOF\n");
    const r = await ok("acct", "POST", `${C}/conversations/${conv.id}/messages`, {
      clientId: randomUUID(), body: "",
      attachments: [
        { fileName: "C:\\fakepath\\Offer letter.pdf", contentType: "application/pdf", size: pdf.length },
        { fileName: "bad.pdf", contentType: "application/pdf", size: EICAR_TEST_STRING.length },
      ],
    }, 201);
    expect(r.message.attachments.map((a: { fileName: string; status: string }) => [a.fileName, a.status]))
      .toEqual([["Offer letter.pdf", "pending"], ["bad.pdf", "pending"]]);
    expect(r.uploads).toHaveLength(2);
    const [good, bad] = r.message.attachments as { id: string }[];
    expect((await call("hr", "POST", `${C}/attachments/${good!.id}/download`)).json().detail).toBe("not_available");
    for (const [i, body] of [[0, pdf], [1, Buffer.from(EICAR_TEST_STRING)]] as const) {
      const up = await app.inject({ method: "POST", url: r.uploads[i].upload.url, ...form(r.uploads[i].upload.fields, body) });
      expect(up.statusCode, up.body).toBe(204);
    }
    await runScan();
    const msgs = await ok("hr", "GET", `${C}/conversations/${conv.id}/messages`);
    const atts = msgs.items.at(-1).attachments as { id: string; status: string }[];
    expect(atts.map((a) => a.status)).toEqual(["clean", "infected"]);
    const dl = await ok("hr", "POST", `${C}/attachments/${good!.id}/download`);
    const file = await app.inject({ method: "GET", url: dl.url });
    expect(file.statusCode).toBe(200);
    expect(file.rawPayload.equals(pdf)).toBe(true);
    expect(String(file.headers["content-disposition"])).toMatch(/^attachment; filename="chat-attachment-[0-9a-f]{8}\.pdf"$/);
    expect((await call("hr", "POST", `${C}/attachments/${bad!.id}/download`)).json().detail).toBe("not_available");
    expect((await call("r1a", "POST", `${C}/attachments/${good!.id}/download`)).statusCode).toBe(404);
    // Deleting the message withdraws its files.
    await ok("acct", "DELETE", `${C}/messages/${r.message.id}`, undefined, 204);
    expect((await call("hr", "POST", `${C}/attachments/${good!.id}/download`)).statusCode).toBe(404);
    // The file name never reached the audit log or the outbox.
    const audit = await db.admin.query(`SELECT 1 FROM eureka.audit_event WHERE changes::text ILIKE '%Offer letter%'`);
    const outbox = await db.admin.query(`SELECT 1 FROM eureka.outbox_event WHERE payload::text ILIKE '%Offer letter%'`);
    expect([audit.rowCount, outbox.rowCount]).toEqual([0, 0]);
  });
});

import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.module.js";
import { loadConfig } from "../src/platform/config.js";
import { createTestDb, type TestDb } from "./db-harness.js";
import { U, seedFixtures } from "./fixtures.js";
import { deliverInbox, emitEvent, newId } from "./notification-seed.js";

/** In-app inbox API (migration 0046): own rows only, keyset paging, read marks. */
let db: TestDb;
let app: NestFastifyApplication;
type Key = keyof typeof U;

beforeAll(async () => {
  db = await createTestDb();
  await seedFixtures(db.admin);
  const url = new URL(process.env.TEST_PG_ADMIN_URL ?? "postgres://postgres:postgres@127.0.0.1:5432");
  app = await createApp(loadConfig({
    NODE_ENV: "test", AUTH_MODE: "dev", SESSION_SECRET: "test-secret-test-secret-test-secret-123",
    DATABASE_URL: `postgres://eureka_app:eureka_app_test@${url.host}/${db.name}`,
  }));
}, 120_000);

afterAll(async () => {
  await app?.close();
  await db?.drop();
});

const sessions = new Map<string, { cookie: string; csrf: string }>();
async function login(key: Key) {
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
async function call(key: Key, method: "GET" | "POST", url: string, payload?: unknown, csrf = true) {
  const s = await login(key);
  return app.inject({ method, url, payload: payload as never,
    headers: { cookie: s.cookie, ...(method === "POST" && csrf ? { "x-csrf-token": s.csrf } : {}) } });
}

/** One in-app event for HR and Accounts; returns the event id. */
async function notifyHrAndAccounts(days = 30) {
  const [a, p, c] = [await newId(db), await newId(db), await newId(db)];
  const ev = await emitEvent(db, "assignment.ending_soon", "assignment", a,
    { assignmentId: a, placementId: p, candidateId: c, endDate: "2026-11-01", daysBefore: days });
  await deliverInbox(db, ev);
  return { ev, placementId: p };
}
const unread = async (key: Key) => (await call(key, "GET", "/api/v1/notifications/unread-count")).json() as { unread: number; capped: boolean };

describe("notifications API", () => {
  it("lists the caller's own notifications newest first, with keyset paging", async () => {
    const made: string[] = [];
    for (let i = 1; i <= 5; i++) made.push((await notifyHrAndAccounts(i)).placementId);
    const page1 = await call("hr", "GET", "/api/v1/notifications?limit=2");
    expect(page1.statusCode, page1.body).toBe(200);
    const b1 = page1.json();
    expect(b1.items).toHaveLength(2);
    expect(b1.items[0]).toMatchObject({ type: "assignment.ending_soon", title: "Project assignment ends within 5 days",
      entity: { type: "placement", id: made[4] }, readAt: null });
    expect(Object.keys(b1.items[0]).sort()).toEqual(["body", "createdAt", "entity", "id", "readAt", "title", "type"]);
    const seen = [...b1.items];
    let cursor = b1.nextCursor as string | null;
    while (cursor) {
      const r = (await call("hr", "GET", `/api/v1/notifications?limit=2&cursor=${encodeURIComponent(cursor)}`)).json();
      seen.push(...r.items);
      cursor = r.nextCursor;
    }
    expect(seen.map((x) => x.entity.id)).toEqual([...made].reverse());
    expect(new Set(seen.map((x) => x.id)).size).toBe(5);
    // Nobody else's rows: the recruiter has none, Immigration was not a recipient.
    expect((await call("r1a", "GET", "/api/v1/notifications")).json()).toEqual({ items: [], nextCursor: null });
    expect((await call("imm", "GET", "/api/v1/notifications")).json().items).toEqual([]);
    expect(await unread("hr")).toEqual({ unread: 5, capped: false });
    expect(await unread("r1a")).toEqual({ unread: 0, capped: false });
  });

  it("marks read and unread only the caller's own rows (404 otherwise), and reads all up to a time", async () => {
    const { ev } = await notifyHrAndAccounts(7);
    const idOf = async (u: string) => (await db.admin.query<{ id: string }>(
      "SELECT id FROM eureka.notification WHERE event_id = $1 AND recipient_id = $2", [ev, u])).rows[0]!.id;
    const [hrRow, acctRow] = [await idOf(U.hr), await idOf(U.acct)];
    const before = (await unread("acct")).unread;

    expect((await call("hr", "POST", `/api/v1/notifications/${acctRow}/read`)).statusCode).toBe(404);
    expect((await call("hr", "POST", `/api/v1/notifications/${await newId(db)}/read`)).statusCode).toBe(404);
    expect((await call("hr", "POST", "/api/v1/notifications/not-a-uuid/read")).statusCode).toBe(400);
    expect((await unread("acct")).unread).toBe(before);

    expect((await call("hr", "POST", `/api/v1/notifications/${hrRow}/read`, undefined, false)).statusCode).toBe(403); // CSRF
    expect((await call("hr", "POST", `/api/v1/notifications/${hrRow}/read`)).statusCode).toBe(204);
    const unreadOnly = (await call("hr", "GET", "/api/v1/notifications?unread=true&limit=50")).json().items as { id: string }[];
    expect(unreadOnly.map((x) => x.id)).not.toContain(hrRow);
    expect((await call("hr", "POST", `/api/v1/notifications/${hrRow}/unread`)).statusCode).toBe(204);
    expect((await call("hr", "GET", "/api/v1/notifications?unread=true&limit=50")).json().items.map((x: { id: string }) => x.id)).toContain(hrRow);

    // read-all with `before`: a notification created later stays unread.
    const cut = new Date().toISOString();
    await new Promise((r) => setTimeout(r, 20));
    const { ev: later } = await notifyHrAndAccounts(8);
    const res = await call("hr", "POST", "/api/v1/notifications/read-all", { before: cut });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().updated).toBeGreaterThan(0);
    expect(await unread("hr")).toEqual({ unread: 1, capped: false });
    expect((await call("hr", "POST", "/api/v1/notifications/read-all")).json()).toEqual({ updated: 1 });
    expect((await unread("hr")).unread).toBe(0);
    // Accounts' rows were never touched.
    expect((await unread("acct")).unread).toBe(before + 1);
    expect((await db.admin.query("SELECT read_at FROM eureka.notification WHERE event_id = $1 AND recipient_id = $2", [later, U.acct])).rows[0].read_at).toBeNull();
  });

  it("refuses unknown query and body keys, bad cursors, and anonymous callers", async () => {
    expect((await call("hr", "GET", "/api/v1/notifications?recipientId=x")).statusCode).toBe(422);
    expect((await call("hr", "GET", "/api/v1/notifications?limit=500")).statusCode).toBe(422);
    expect((await call("hr", "GET", "/api/v1/notifications?cursor=bm9wZQ")).statusCode).toBe(422);
    expect((await call("hr", "POST", "/api/v1/notifications/read-all", { before: "yesterday" })).statusCode).toBe(422);
    expect((await call("hr", "POST", "/api/v1/notifications/read-all", { recipientId: U.acct })).statusCode).toBe(422);
    for (const url of ["/api/v1/notifications", "/api/v1/notifications/unread-count"]) {
      expect((await app.inject({ method: "GET", url })).statusCode).toBe(401);
    }
  });
});

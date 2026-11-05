import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.module.js";
import { CALENDAR_PROVIDER, type CoachEvent, DevCalendarProvider } from "../src/modules/calendar/calendar.provider.js";
import { CalendarService } from "../src/modules/calendar/calendar.service.js";
import { loadConfig } from "../src/platform/config.js";
import { asUser, createTestDb, type TestDb } from "./db-harness.js";
import { U, seedFixtures } from "./fixtures.js";
import { extraUser } from "./placement-seed.js";

/** Coaches' Google Calendars on the coach grid (docs/coach-calendar-api.md CC-6..CC-8, migration 0550). */
let db: TestDb;
let app: NestFastifyApplication;
let coach2: string;
const SECRET = "test-secret-test-secret-test-secret-123";
const FROM = "2033-03-01T00:00:00Z", TO = "2033-03-08T00:00:00Z";
const URL_EVENTS = `/api/v1/coach-calendar/google?from=${encodeURIComponent(FROM)}&to=${encodeURIComponent(TO)}`;
const TITLE = "Quarterly review with Jane";
const SAMPLE: CoachEvent[] = [
  { allDay: false, startsAt: new Date("2033-03-02T15:00:00Z"), endsAt: new Date("2033-03-02T16:00:00Z"), title: TITLE },
  { allDay: false, startsAt: new Date("2033-03-02T18:00:00Z"), endsAt: new Date("2033-03-02T18:30:00Z"), title: null },
  { allDay: true, startDate: "2033-03-03", endDate: "2033-03-04", title: "Out of office" },
];
const sessions = new Map<string, { cookie: string; csrf: string }>();
const provider = () => app.get<DevCalendarProvider>(CALENDAR_PROVIDER);

async function session(user: string) {
  let s = sessions.get(user);
  if (!s) {
    const key = Object.entries(U).find(([, id]) => id === user)?.[0] ?? "coach2";
    const r = await app.inject({ method: "POST", url: "/api/auth/dev-login", payload: { email: `${key}@eureka.example` } });
    expect(r.statusCode, r.body).toBe(204);
    const cookie = String(r.headers["set-cookie"]).split(";")[0]!;
    const me = await app.inject({ method: "GET", url: "/api/v1/me", headers: { cookie } });
    s = { cookie, csrf: me.json<{ csrfToken: string }>().csrfToken };
    sessions.set(user, s);
  }
  return s;
}
async function call(user: string, method: "GET" | "POST" | "DELETE", url: string, payload?: unknown) {
  const s = await session(user);
  return app.inject({ method, url, ...(payload === undefined ? {} : { payload: payload as object }), headers: { cookie: s.cookie, "x-csrf-token": s.csrf } });
}
/** Runs the OAuth round trip; returns where the callback sent the browser. */
async function connect(user: string, next?: DevCalendarProvider["nextCoachExchange"]) {
  provider().nextCoachExchange = next ?? null;
  const start = await call(user, "GET", "/api/v1/coach-calendar/google/connect");
  expect(start.statusCode, start.body).toBe(302);
  const loc = new URL(String(start.headers.location));
  const state = String(start.headers["set-cookie"]).split(";")[0]!;
  const s = await session(user);
  const done = await app.inject({ method: "GET", url: `${loc.pathname}${loc.search}`, headers: { cookie: `${s.cookie}; ${state}` } });
  expect(done.statusCode, done.body).toBe(302);
  return new URL(String(done.headers.location)).searchParams.get("google");
}
interface Google {
  enabled: boolean; me: { canConnect: boolean; connected: boolean; accountEmail: string | null };
  coaches: { coachId: string; status: string }[];
  events: { coachId: string; startsAt: string; endsAt: string; title: string | null }[];
  allDay: { coachId: string; startDate: string; endDate: string; title: string | null }[];
}
const google = async (user: string) => {
  const r = await call(user, "GET", URL_EVENTS);
  expect(r.statusCode, r.body).toBe(200);
  return r.json<Google>();
};
const grant = async (b: object) => {
  const r = await call(U.ceo, "POST", "/api/v1/coach-calendar/grants", b);
  expect(r.statusCode, r.body).toBe(201);
};

beforeAll(async () => {
  db = await createTestDb();
  await seedFixtures(db.admin);
  coach2 = (await extraUser(db, "coach2", "interview_coach")).id;
  const url = new URL(process.env.TEST_PG_ADMIN_URL ?? "postgres://postgres:postgres@127.0.0.1:5432");
  app = await createApp(loadConfig({
    NODE_ENV: "test", AUTH_MODE: "dev", SESSION_SECRET: SECRET, GOOGLE_HOSTED_DOMAIN: "eureka.example",
    DATABASE_URL: `postgres://eureka_app:eureka_app_test@${url.host}/${db.name}`,
  }));
}, 120_000);

afterAll(async () => {
  await app?.close();
  await db?.drop();
});

beforeEach(async () => {
  await db.admin.query(`ALTER TABLE eureka.coach_google_connection DISABLE TRIGGER USER; DELETE FROM eureka.coach_google_connection; ALTER TABLE eureka.coach_google_connection ENABLE TRIGGER USER; DELETE FROM eureka.coach_calendar_grant`);
  provider().coachCalendars.clear();
  provider().revoked.length = 0;
  provider().coachCalendars.set("tok-coach", SAMPLE);
});

describe("connecting", () => {
  it("a coach connects their own account, and the token is only stored encrypted", async () => {
    expect((await google(U.coach)).me).toEqual({ canConnect: true, connected: false, accountEmail: null });
    expect(await connect(U.coach, { refreshToken: "tok-coach" })).toBe("connected");
    expect((await google(U.coach)).me).toEqual({ canConnect: true, connected: true, accountEmail: "coach@eureka.example" });
    const row = (await db.admin.query<{ token_enc: string }>(`SELECT token_enc FROM eureka.coach_google_connection WHERE user_id = $1`, [U.coach])).rows[0]!;
    expect(row.token_enc).not.toContain("tok-coach");
  });

  it("refuses somebody else's Google account and drops the token without revoking that account's grant", async () => {
    expect(await connect(U.coach, { refreshToken: "tok-other", email: "someone@gmail.example" })).toBe("wrong_account");
    expect((await google(U.coach)).me.connected).toBe(false);
    expect(provider().revoked).toEqual([]);
  });

  it("refuses the right address on an unverified Google account", async () => {
    expect(await connect(U.coach, { refreshToken: "tok-unverified", emailVerified: false })).toBe("wrong_account");
    expect((await google(U.coach)).me.connected).toBe(false);
  });

  it("a failure at Google during the callback shows as failed and saves nothing", async () => {
    const start = await call(U.coach, "GET", "/api/v1/coach-calendar/google/connect");
    const loc = new URL(String(start.headers.location));
    const state = String(start.headers["set-cookie"]).split(";")[0]!;
    const done = await app.inject({
      method: "GET", url: `${loc.pathname}?code=bad&state=${loc.searchParams.get("state")}`,
      headers: { cookie: `${(await session(U.coach)).cookie}; ${state}` },
    });
    expect(new URL(String(done.headers.location)).searchParams.get("google")).toBe("failed");
    expect((await google(U.coach)).me.connected).toBe(false);
  });

  it("refuses a consent with the calendar permission unticked", async () => {
    expect(await connect(U.coach, { refreshToken: "tok-noscope", scopes: "openid email" })).toBe("scope_missing");
    expect((await google(U.coach)).me.connected).toBe(false);
    expect(provider().revoked).toEqual([]);
  });

  it("only coaches may connect, including through the database function", async () => {
    expect((await call(U.ceo, "GET", "/api/v1/coach-calendar/google/connect")).statusCode).toBe(403);
    expect((await call(U.l1, "GET", "/api/v1/coach-calendar/google/connect")).statusCode).toBe(403);
    await expect(asUser(db.app, U.l1, (c) => c.query(`SELECT authz.coach_google_connect('dev', 'l1@eureka.example', 'AAAA', 'x')`), true)).rejects.toThrow(/not_permitted/);
    await expect(asUser(db.app, U.coach, (c) => c.query(`SELECT authz.coach_google_connect('dev', NULL, 'AAAA', 'x')`), true)).rejects.toThrow(/wrong_account/);
  });

  it("a state signed for the support calendar flow cannot finish this one", async () => {
    const { cookie, state } = app.get(CalendarService).signState("support@eureka.example", U.coach);
    const r = await app.inject({
      method: "GET", url: `/api/v1/coach-calendar/google/callback?code=dev:coach@eureka.example&state=${state}`,
      headers: { cookie: `${(await session(U.coach)).cookie}; eureka_coach_google=${cookie}` },
    });
    expect(r.statusCode).toBe(403);
    expect((await google(U.coach)).me.connected).toBe(false);
  });

  it("someone else's session cannot finish the round trip, nor a missing cookie", async () => {
    const start = await call(U.coach, "GET", "/api/v1/coach-calendar/google/connect");
    const loc = new URL(String(start.headers.location));
    const state = String(start.headers["set-cookie"]).split(";")[0]!;
    const other = await app.inject({ method: "GET", url: `${loc.pathname}${loc.search}`, headers: { cookie: `${(await session(coach2)).cookie}; ${state}` } });
    expect(other.statusCode).toBe(403);
    const none = await app.inject({ method: "GET", url: `${loc.pathname}${loc.search}`, headers: { cookie: (await session(U.coach)).cookie } });
    expect(none.statusCode).toBe(403);
    expect((await google(U.coach)).me.connected).toBe(false);
  });

  it("cancelling at Google says so and saves nothing", async () => {
    const start = await call(U.coach, "GET", "/api/v1/coach-calendar/google/connect");
    const loc = new URL(String(start.headers.location));
    const state = String(start.headers["set-cookie"]).split(";")[0]!;
    const done = await app.inject({
      method: "GET", url: `${loc.pathname}?error=access_denied&state=${loc.searchParams.get("state")}`,
      headers: { cookie: `${(await session(U.coach)).cookie}; ${state}` },
    });
    expect(new URL(String(done.headers.location)).searchParams.get("google")).toBe("cancelled");
    expect((await google(U.coach)).me.connected).toBe(false);
  });

  it("disconnecting removes the row, revokes at Google and is idempotent", async () => {
    await connect(U.coach, { refreshToken: "tok-coach" });
    expect((await call(U.coach, "DELETE", "/api/v1/coach-calendar/google/connection")).statusCode).toBe(204);
    expect((await google(U.coach)).me.connected).toBe(false);
    expect(provider().revoked).toEqual(["tok-coach"]);
    expect((await call(U.coach, "DELETE", "/api/v1/coach-calendar/google/connection")).statusCode).toBe(204);
    expect(provider().revoked).toEqual(["tok-coach"]);
  });

  it("disconnecting does not revoke when the same account holds the shared support calendar", async () => {
    await connect(U.coach, { refreshToken: "tok-coach" });
    await db.admin.query(`ALTER TABLE eureka.calendar_connection DISABLE TRIGGER USER;
      INSERT INTO eureka.calendar_connection (key, provider, calendar_id, account_email, token_enc, connected_by, scopes)
      VALUES ('support', 'dev', 'support', 'COACH@eureka.example', 'AAAA', '${U.coach}', 'x');
      ALTER TABLE eureka.calendar_connection ENABLE TRIGGER USER`);
    expect((await call(U.coach, "DELETE", "/api/v1/coach-calendar/google/connection")).statusCode).toBe(204);
    await db.admin.query(`DELETE FROM eureka.calendar_connection`);
    expect((await google(U.coach)).me.connected).toBe(false);
    expect(provider().revoked).toEqual([]);
  });

  it("one person cannot disconnect another", async () => {
    await connect(U.coach, { refreshToken: "tok-coach" });
    expect((await call(coach2, "DELETE", "/api/v1/coach-calendar/google/connection")).statusCode).toBe(204);
    expect((await google(U.coach)).me.connected).toBe(true);
  });
});

describe("who sees what", () => {
  beforeEach(async () => { await connect(U.coach, { refreshToken: "tok-coach" }); });

  it("the CEO sees titles, private events as untitled, and which coaches aren't connected", async () => {
    const g = await google(U.ceo);
    expect(g.me.canConnect).toBe(false);
    expect(g.coaches).toEqual(expect.arrayContaining([{ coachId: U.coach, status: "connected" }, { coachId: coach2, status: "not_connected" }]));
    expect(g.events.map((e) => e.title)).toEqual([TITLE, null]);
    expect(g.allDay).toEqual([{ coachId: U.coach, startDate: "2033-03-03", endDate: "2033-03-04", title: "Out of office" }]);
  });

  it("a coach sees their own events but not another coach's", async () => {
    expect((await google(U.coach)).events.map((e) => e.title)).toEqual([TITLE, null]);
    const other = await google(coach2);
    expect(other.events).toEqual([]);
    expect(other.coaches.map((c) => c.coachId)).toEqual([coach2]);
  });

  it("a busy-only grant gets times and never a title", async () => {
    await grant({ granteeUserId: U.il, allCoaches: true, detail: "busy" });
    const g = await google(U.il);
    expect(g.events).toHaveLength(2);
    expect(g.events.every((e) => e.title === null)).toBe(true);
    expect(g.allDay.every((e) => e.title === null)).toBe(true);
    expect(JSON.stringify(g)).not.toContain(TITLE);
  });

  it("a full grant gets titles, only for the coaches it names", async () => {
    await grant({ granteeUserId: U.il, allCoaches: false, coachIds: [coach2], detail: "full" });
    expect((await google(U.il)).events).toEqual([]);
    await grant({ granteeUserId: U.il, allCoaches: false, coachIds: [U.coach], detail: "full" });
    expect((await google(U.il)).events[0]!.title).toBe(TITLE);
  });

  it("no access means 403, and the database gives no tokens either", async () => {
    expect((await call(U.l1, "GET", URL_EVENTS)).statusCode).toBe(403);
    expect((await call(U.admin, "GET", URL_EVENTS)).statusCode).toBe(403);
    const rows = await asUser(db.app, U.l1, async (c) => (await c.query(`SELECT * FROM authz.coach_google_connections()`)).rows);
    expect(rows).toEqual([]);
  });

  it("the API role cannot touch the table directly, whoever is signed in", async () => {
    await expect(asUser(db.app, U.ceo, (c) => c.query(`SELECT token_enc FROM eureka.coach_google_connection`))).rejects.toThrow(/permission denied/);
    await expect(asUser(db.app, U.coach, (c) => c.query(`DELETE FROM eureka.coach_google_connection`))).rejects.toThrow(/permission denied/);
  });

  it("rejects a window over 31 days, before asking Google", async () => {
    const r = await call(U.ceo, "GET", `/api/v1/coach-calendar/google?from=${encodeURIComponent(FROM)}&to=${encodeURIComponent("2033-06-01T00:00:00Z")}`);
    expect(r.statusCode).toBe(422);
  });
});

describe("when Google fails", () => {
  beforeEach(async () => { await connect(U.coach, { refreshToken: "tok-coach" }); });

  it("a dead token asks for a reconnect, and the other coaches still load", async () => {
    await connect(coach2, { refreshToken: "tok-coach2" });
    provider().coachCalendars.set("tok-coach", new Error("calendar token request failed (400)"));
    provider().coachCalendars.set("tok-coach2", SAMPLE);
    const g = await google(U.ceo);
    expect(g.coaches).toEqual(expect.arrayContaining([{ coachId: U.coach, status: "reconnect" }, { coachId: coach2, status: "connected" }]));
    expect(g.events.every((e) => e.coachId === coach2)).toBe(true);
  });

  it("an outage shows as unavailable, not as a reconnect, without the provider's message", async () => {
    provider().coachCalendars.set("tok-coach", new Error("calendar events read failed (503)"));
    const r = await call(U.ceo, "GET", URL_EVENTS);
    expect(r.statusCode).toBe(200);
    expect(r.json<Google>().coaches).toContainEqual({ coachId: U.coach, status: "unavailable" });
    expect(r.body).not.toContain("read failed");
  });

  it("a Calendar API switched off is unavailable, and a missing permission asks for a reconnect", async () => {
    provider().coachCalendars.set("tok-coach", new Error("calendar events read failed (403 accessNotConfigured)"));
    expect((await google(U.ceo)).coaches).toContainEqual({ coachId: U.coach, status: "unavailable" });
    provider().coachCalendars.set("tok-coach", new Error("calendar events read failed (403 insufficientPermissions)"));
    expect((await google(U.ceo)).coaches).toContainEqual({ coachId: U.coach, status: "reconnect" });
  });

  it("a token that no longer decrypts asks for a reconnect", async () => {
    await db.admin.query(`UPDATE eureka.coach_google_connection SET token_enc = 'AAAA' WHERE user_id = $1`, [U.coach]).catch(async () => {
      await db.admin.query(`ALTER TABLE eureka.coach_google_connection DISABLE TRIGGER USER; UPDATE eureka.coach_google_connection SET token_enc = 'AAAA'; ALTER TABLE eureka.coach_google_connection ENABLE TRIGGER USER`);
    });
    expect((await google(U.coach)).coaches).toContainEqual({ coachId: U.coach, status: "reconnect" });
  });
});

describe("the token does not outlive the job", () => {
  it("revoking the coach role removes the connection", async () => {
    await connect(coach2, { refreshToken: "tok-coach2" });
    const r = await call(U.admin, "DELETE", `/api/v1/admin/users/${coach2}/roles/interview_coach`);
    expect(r.statusCode, r.body).toBeLessThan(300);
    expect((await db.admin.query(`SELECT 1 FROM eureka.coach_google_connection WHERE user_id = $1`, [coach2])).rowCount).toBe(0);
    await db.admin.query(`INSERT INTO eureka.user_role (user_id, role_key) VALUES ($1, 'interview_coach')`, [coach2]).catch(() => undefined);
  });

  it("deactivating the coach removes the connection", async () => {
    const leaver = (await extraUser(db, "coach3", "interview_coach")).id;
    await asUser(db.app, leaver, (c) => c.query(`SELECT authz.coach_google_connect('dev', (SELECT email::text FROM eureka.app_user WHERE id = $1), 'AAAA', 'x')`, [leaver]), true);
    await asUser(db.app, U.admin, (c) => c.query(`SELECT authz.admin_set_user_status($1, false)`, [leaver]), true);
    expect((await db.admin.query(`SELECT 1 FROM eureka.coach_google_connection WHERE user_id = $1`, [leaver])).rowCount).toBe(0);
  });
});

describe("audit (rule 5)", () => {
  it("records connect and disconnect with no account, token or title", async () => {
    await connect(U.coach, { refreshToken: "tok-coach" });
    await google(U.ceo);
    await call(U.coach, "DELETE", "/api/v1/coach-calendar/google/connection");
    const { rows } = await db.admin.query<{ action: string; row: string }>(
      `SELECT action, row_to_json(a)::text AS row FROM eureka.audit_event a WHERE action LIKE 'coach_calendar.google%' ORDER BY seq DESC LIMIT 2`);
    expect(rows.map((r) => r.action)).toEqual(["coach_calendar.google_disconnected", "coach_calendar.google_connected"]);
    for (const { row } of rows) {
      expect(row).not.toContain("@eureka.example");
      expect(row).not.toContain("tok-coach");
      expect(row).not.toContain(TITLE);
    }
  });
});

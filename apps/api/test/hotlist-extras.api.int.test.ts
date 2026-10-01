import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HOTLIST_STATUSES, can, ownsCandidate, resolveScope, type Permission } from "@eureka/shared";
import { createApp } from "../src/app.module.js";
import { loadConfig } from "../src/platform/config.js";
import { EXPORTS_PER_WINDOW, EXPORT_ROW_CAP } from "../src/modules/hotlist/hotlist.service.js";
import { createTestDb, type TestDb } from "./db-harness.js";
import { T, TECH_ID, U, seedFixtures, toUserAccess, type FixtureCandidate } from "./fixtures.js";

/** Hot List extras over HTTP: saved views, bulk actions (per-record authorization) and export. */
let db: TestDb;
let app: NestFastifyApplication;
let candidates: FixtureCandidate[];
const SECRET = "test-secret-test-secret-test-secret-123";
const users = Object.keys(U) as (keyof typeof U)[];
const HOT = new Set<string>(HOTLIST_STATUSES);
const NOBODY = "99999999-9999-4999-8999-999999999999";

beforeAll(async () => {
  db = await createTestDb();
  candidates = await seedFixtures(db.admin);
  const url = new URL(process.env.TEST_PG_ADMIN_URL ?? "postgres://postgres:postgres@127.0.0.1:5432");
  app = await createApp(loadConfig({
    NODE_ENV: "test", AUTH_MODE: "dev", SESSION_SECRET: SECRET,
    DATABASE_URL: `postgres://eureka_app:eureka_app_test@${url.host}/${db.name}`,
  }));
}, 90_000);

afterAll(async () => {
  await app?.close();
  await db?.drop();
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

async function call(key: keyof typeof U, method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: unknown, csrf = true) {
  const s = await login(key);
  return app.inject({
    method, url, payload: payload as never,
    headers: { cookie: s.cookie, ...(csrf && method !== "GET" ? { "x-csrf-token": s.csrf } : {}) },
  });
}

const audits = async (action: string, actor: string) =>
  (await db.admin.query<{ changes: Record<string, unknown> }>(
    `SELECT changes FROM eureka.audit_event WHERE action = $1 AND actor_id = $2 ORDER BY seq`, [action, actor])).rows;

/** CSV data rows (BOM and header removed). */
const csvRows = (body: string) => body.replace(/^﻿/, "").split("\r\n").filter(Boolean).slice(1);

describe("permission matrix (generated from the catalog)", () => {
  const endpoints: { perm: Permission; method: "GET" | "POST"; url: string; body?: unknown }[] = [
    { perm: "hotlist:read", method: "GET", url: "/api/v1/hotlist/views" },
    { perm: "hotlist:read", method: "POST", url: "/api/v1/hotlist/views", body: { bogus: 1 } },
    { perm: "candidate.visibility:update", method: "POST", url: "/api/v1/hotlist/bulk/visibility", body: { ids: [NOBODY], visibility: "team" } },
    { perm: "candidate:update", method: "POST", url: "/api/v1/hotlist/bulk/status", body: { ids: [NOBODY], to: "active" } },
    { perm: "report:export", method: "POST", url: "/api/v1/hotlist/export", body: { status: "bench" } },
  ];
  const cases = users.flatMap((u) => endpoints.map((e) => [u, e.perm, e.url, e] as const));

  it.each(cases)("%s → %s (%s)", async (key, perm, _url, e) => {
    const res = await call(key, e.method, e.url, e.body);
    if (can(toUserAccess(key), perm)) expect(res.statusCode, res.body).not.toBe(403);
    else expect(res.statusCode, res.body).toBe(403);
  });
});

describe("saved views", () => {
  it("a user saves, lists, renames, updates and deletes their own views", async () => {
    const created = await call("r1a", "POST", "/api/v1/hotlist/views", { name: " Java bench ", filters: { status: "bench", technology: "Java" } });
    expect(created.statusCode).toBe(201);
    const v = created.json();
    expect(v).toMatchObject({ name: "Java bench", filters: { status: "bench", technology: "Java" } });
    await call("r1a", "POST", "/api/v1/hotlist/views", { name: "Active", filters: { status: "active" } });

    const list = (await call("r1a", "GET", "/api/v1/hotlist/views")).json();
    expect(list.items.map((i: { name: string }) => i.name)).toEqual(["Active", "Java bench"]);

    const renamed = await call("r1a", "PATCH", `/api/v1/hotlist/views/${v.id}`, { name: "Bench (Java)" });
    expect(renamed.json()).toMatchObject({ id: v.id, name: "Bench (Java)", filters: { status: "bench", technology: "Java" } });
    const refiltered = await call("r1a", "PATCH", `/api/v1/hotlist/views/${v.id}`, { filters: { visibility: "all_teams" } });
    expect(refiltered.json().filters).toEqual({ visibility: "all_teams" });

    expect((await call("r1a", "POST", "/api/v1/hotlist/views", { name: "active", filters: {} })).statusCode).toBe(409);
    expect((await call("r1a", "DELETE", `/api/v1/hotlist/views/${v.id}`)).statusCode).toBe(204);
    expect((await call("r1a", "DELETE", `/api/v1/hotlist/views/${v.id}`)).statusCode).toBe(404);
  });

  it("views are private: another user sees none of them and gets 404 on rename or delete", async () => {
    const v = (await call("r1a", "POST", "/api/v1/hotlist/views", { name: "Private", filters: {} })).json();
    for (const key of ["r1b", "l1", "m1", "ceo", "admin"] as const) {
      const list = (await call(key, "GET", "/api/v1/hotlist/views")).json();
      expect(list.items.map((i: { id: string }) => i.id), key).not.toContain(v.id);
      expect((await call(key, "PATCH", `/api/v1/hotlist/views/${v.id}`, { name: "Mine now" })).statusCode, key).toBe(404);
      expect((await call(key, "DELETE", `/api/v1/hotlist/views/${v.id}`)).statusCode, key).toBe(404);
    }
    expect((await call("r1a", "GET", "/api/v1/hotlist/views")).json().items.map((i: { name: string }) => i.name)).toContain("Private");
  });

  it.each([
    ["an unknown filter", { name: "x", filters: { teamId: T.t1 } }],
    ["an owner", { name: "x", filters: {}, ownerId: U.r1b }],
    ["a non-Hot-List status", { name: "x", filters: { status: "placed" } }],
    ["an empty name", { name: "  ", filters: {} }],
    ["a long name", { name: "x".repeat(81), filters: {} }],
  ])("rejects %s with 422", async (_what, body) => {
    expect((await call("r1b", "POST", "/api/v1/hotlist/views", body)).statusCode).toBe(422);
  });

  it("writes need the CSRF token", async () => {
    expect((await call("r1b", "POST", "/api/v1/hotlist/views", { name: "x", filters: {} }, false)).statusCode).toBe(403);
  });
});

describe("bulk actions re-check every record", () => {
  const find = (p: (c: FixtureCandidate) => boolean) => candidates.find(p)!;
  const visibilityOf = async (id: string) =>
    (await db.admin.query(`SELECT visibility FROM eureka.candidate WHERE id = $1`, [id])).rows[0].visibility as string;
  const statusOf = async (id: string) =>
    (await db.admin.query(`SELECT marketing_status FROM eureka.candidate WHERE id = $1`, [id])).rows[0].marketing_status as string;

  it("visibility: a lead changes own-team records only; each record reports its outcome", async () => {
    const own = find((c) => c.teamId === T.t1 && c.visibility === "team" && c.marketingStatus === "active");
    const otherVisible = find((c) => c.teamId === T.t2 && c.visibility === "all_teams" && c.marketingStatus === "active");
    const otherHidden = find((c) => c.teamId === T.t3 && c.visibility === "team" && c.marketingStatus === "active");
    const before = await visibilityOf(otherVisible.id);
    const r = await call("l1", "POST", "/api/v1/hotlist/bulk/visibility",
      { ids: [own.id, otherVisible.id, otherHidden.id, NOBODY], visibility: "all_teams" });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({
      succeeded: 1, failed: 3, results: [
        { id: own.id, ok: true },
        { id: otherVisible.id, ok: false, error: "forbidden" },
        { id: otherHidden.id, ok: false, error: "not_found" },
        { id: NOBODY, ok: false, error: "not_found" },
      ],
    });
    expect(await visibilityOf(own.id)).toBe("all_teams");
    expect(await visibilityOf(otherVisible.id)).toBe(before);
    expect(await visibilityOf(otherHidden.id)).toBe("team");
    // Each change is audited like its single-record endpoint, plus one summary without candidate data.
    const per = await audits("candidate.visibility", U.l1);
    expect(per.at(-1)!.changes).toEqual({ visibility: "all_teams" });
    expect((await audits("hotlist.bulk", U.l1)).at(-1)!.changes).toEqual(
      { action: "visibility", value: "all_teams", requested: 4, succeeded: 1, failed: 3 });
  });

  it("status: a recruiter moves own candidates; teammates' are forbidden, invalid moves reported", async () => {
    const own = find((c) => c.recruiterId === U.r1a && c.visibility === "team" && c.marketingStatus === "active");
    const ownStopped = find((c) => c.recruiterId === U.r1a && c.marketingStatus === "stopped");
    const teammate = find((c) => c.recruiterId === U.r1b && c.marketingStatus === "active");
    const r = await call("r1a", "POST", "/api/v1/hotlist/bulk/status", { ids: [own.id, ownStopped.id, teammate.id], to: "on_hold" });
    expect(r.json().results).toEqual([
      { id: own.id, ok: true },
      { id: ownStopped.id, ok: false, error: "invalid_transition" },
      { id: teammate.id, ok: false, error: "forbidden" },
    ]);
    expect(await statusOf(own.id)).toBe("on_hold");
    expect(await statusOf(teammate.id)).toBe("active");
    await call("r1a", "POST", "/api/v1/hotlist/bulk/status", { ids: [own.id], to: "active" });
    expect(await statusOf(own.id)).toBe("active");
  });

  it("a candidate seen only on the open Hot List cannot be changed in bulk", async () => {
    const hotOnly = find((c) => c.teamId === T.t3 && c.visibility === "team" && c.marketingStatus === "active");
    const r = await call("m1", "POST", "/api/v1/hotlist/bulk/visibility", { ids: [hotOnly.id], visibility: "all_teams" });
    expect(r.json().results).toEqual([{ id: hotOnly.id, ok: false, error: "not_found" }]);
    expect(await visibilityOf(hotOnly.id)).toBe("team");
  });

  it.each([
    ["too many ids", { ids: Array.from({ length: 101 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`), to: "active" }],
    ["duplicate ids", { ids: [NOBODY, NOBODY], to: "active" }],
    ["terminated (one record at a time only)", { ids: [NOBODY], to: "terminated" }],
    ["confirmation (driven by placements)", { ids: [NOBODY], to: "confirmation" }],
    ["no ids", { ids: [], to: "active" }],
  ])("rejects %s with 422", async (_what, body) => {
    expect((await call("l2", "POST", "/api/v1/hotlist/bulk/status", body)).statusCode).toBe(422);
  });
});

describe("export", () => {
  const expectedFor = (key: keyof typeof U, f: (c: FixtureCandidate) => boolean = () => true) => {
    const scope = resolveScope(toUserAccess(key), "report:export")!;
    return candidates.filter((c) => HOT.has(c.marketingStatus) && ownsCandidate(scope, c) && f(c));
  };

  it("a lead exports their team's Hot List rows as CSV with phones masked, audited without candidate data", async () => {
    const r = await call("l1", "POST", "/api/v1/hotlist/export", {});
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toContain("text/csv");
    expect(r.headers["content-disposition"]).toMatch(/^attachment; filename="hotlist-\d{4}-\d{2}-\d{2}\.csv"$/);
    expect(r.headers["x-export-truncated"]).toBe("false");
    const body = r.body.replace(/^﻿/, "");
    expect(body.split("\r\n")[0]).toBe("Candidate,Technology,Status,Visibility,Priority,Team,Recruiter,Location,Phone,Marketing since,Days in market,Technical rating");
    const rows = csvRows(r.body);
    const expected = expectedFor("l1");
    expect(rows).toHaveLength(expected.length);
    expect(r.headers["x-export-rows"]).toBe(String(expected.length));
    expect(body).not.toMatch(/\+1469/);
    for (const row of rows) expect(row.split(",")[8]).toMatch(/^•••-•••-\d\d$/);
    expect(rows.every((row) => row.includes("Team Rohit"))).toBe(true);

    const audit = (await audits("hotlist.export", U.l1)).at(-1)!.changes;
    expect(audit).toEqual({ filters: {}, rows: expected.length, truncated: false, cap: EXPORT_ROW_CAP });
  });

  it("exports the filtered view; the name search is audited as a flag, never as text", async () => {
    const r = await call("m1", "POST", "/api/v1/hotlist/export", { status: "on_hold", visibility: "all_teams", search: "Cand" });
    expect(csvRows(r.body)).toHaveLength(expectedFor("m1", (c) => c.marketingStatus === "on_hold" && c.visibility === "all_teams").length);
    const audit = (await audits("hotlist.export", U.m1)).at(-1)!.changes;
    expect(audit.filters).toEqual({ status: "on_hold", visibility: "all_teams", search: true });
    expect(JSON.stringify(audit)).not.toMatch(/Cand|1469/);
  });

  it("the technology filter is audited as a flag, never as text", async () => {
    const text = "Jane Doe +14695550123 jane@example.com";
    const r = await call("l2", "POST", "/api/v1/hotlist/export", { technology: text });
    expect(r.statusCode).toBe(200);
    expect(csvRows(r.body)).toHaveLength(0);
    const audit = (await audits("hotlist.export", U.l2)).at(-1)!.changes;
    expect(audit.filters).toEqual({ technology: true });
    expect(JSON.stringify(audit)).not.toMatch(/Jane|Doe|1469|example\.com|@/);
  });

  it("rejects unknown filters and needs the CSRF token", async () => {
    expect((await call("ad", "POST", "/api/v1/hotlist/export", { teamId: T.t1 })).statusCode).toBe(422);
    expect((await call("ad", "POST", "/api/v1/hotlist/export", {}, false)).statusCode).toBe(403);
  });

  it("is rate limited per user", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < EXPORTS_PER_WINDOW + 1; i++) statuses.push((await call("l3", "POST", "/api/v1/hotlist/export", { status: "bench" })).statusCode);
    expect(statuses.filter((s) => s === 200).length).toBeLessThanOrEqual(EXPORTS_PER_WINDOW);
    expect(statuses.at(-1)).toBe(429);
  });

  it(`is capped at ${EXPORT_ROW_CAP.toLocaleString("en-US")} rows and says so`, async () => {
    // 50,001 extra Hot List candidates in team t3 (CEO exports at org scope).
    await db.admin.query(`
      WITH p AS (
        INSERT INTO eureka.person (first_name, last_name, phone_e164)
        SELECT 'Bulk' || g, 'Row', '+1555' || lpad(g::text, 7, '0') FROM generate_series(1, ${EXPORT_ROW_CAP + 1}) g
        RETURNING id)
      INSERT INTO eureka.candidate (person_id, technology_id, team_id, location_id, marketing_status)
      SELECT p.id, $1, $2, l.id, 'active' FROM p, (SELECT id FROM eureka.location ORDER BY id LIMIT 1) l`, [TECH_ID, T.t3]);
    const r = await call("ceo", "POST", "/api/v1/hotlist/export", {});
    expect(r.statusCode).toBe(200);
    expect(r.headers["x-export-truncated"]).toBe("true");
    expect(r.headers["x-export-rows"]).toBe(String(EXPORT_ROW_CAP));
    expect(csvRows(r.body)).toHaveLength(EXPORT_ROW_CAP);
    expect((await audits("hotlist.export", U.ceo)).at(-1)!.changes).toMatchObject({ rows: EXPORT_ROW_CAP, truncated: true });
  }, 120_000);
});

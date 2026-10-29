import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { can, type Permission } from "@eureka/shared";
import { createApp } from "../src/app.module.js";
import { loadConfig } from "../src/platform/config.js";
import { asUser, createTestDb, type TestDb } from "./db-harness.js";
import { CLIENT_ID, LOC, U, seedFixtures, toUserAccess } from "./fixtures.js";

/**
 * GET /api/v1/lookups (docs/placements-api.md "Lookups"): every signed-in user
 * may call it, but the coach roster and the client/vendor/implementation-partner
 * lists are least-privilege (empty arrays for callers without the permissions).
 */
let db: TestDb;
let app: NestFastifyApplication;
const SECRET = "test-secret-test-secret-test-secret-123";

beforeAll(async () => {
  db = await createTestDb();
  await seedFixtures(db.admin);
  await db.admin.query(`INSERT INTO eureka.vendor (name) VALUES ('Acme Staffing')`);
  await db.admin.query(`INSERT INTO eureka.implementation_partner (name) VALUES ('Prime IP')`);
  await db.admin.query(`INSERT INTO eureka.technology (name, active) VALUES ('Cobol', false)`);
  const url = new URL(process.env.TEST_PG_ADMIN_URL ?? "postgres://postgres:postgres@127.0.0.1:5432");
  app = await createApp(loadConfig({
    NODE_ENV: "test", AUTH_MODE: "dev", SESSION_SECRET: SECRET,
    DATABASE_URL: `postgres://eureka_app:eureka_app_test@${url.host}/${db.name}`,
  }));
}, 120_000);

afterAll(async () => {
  await app?.close();
  await db?.drop();
});

type Key = keyof typeof U;
const users = Object.keys(U) as Key[];

async function login(key: Key) {
  const res = await app.inject({ method: "POST", url: "/api/auth/dev-login", payload: { email: `${key}@eureka.example` } });
  expect(res.statusCode).toBe(204);
  return String(res.headers["set-cookie"]).split(";")[0]!;
}

async function lookups(key: Key) {
  const cookie = await login(key);
  const res = await app.inject({ method: "GET", url: "/api/v1/lookups", headers: { cookie } });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as Record<string, { id: string; name: string }[]>;
}

/** Pinned matrix (who sees what), independent of the engine so a grant change is a visible test change. */
const SEES_COACHES = new Set<Key>(["ad", "m1", "m2", "l1", "l2", "l3", "r1a", "r1b", "r2a", "r3a", "locD", "locA"]);
const SEES_PARTIES = new Set<Key>([...SEES_COACHES, "ceo", "hr", "acct"]);

const anyOf = (key: Key, perms: Permission[]) => perms.some((p) => can(toUserAccess(key), p));

describe("lookups", () => {
  it("pinned matrix agrees with the shared engine", () => {
    for (const key of users) {
      expect(anyOf(key, ["interview:create", "interview:update"]), key).toBe(SEES_COACHES.has(key));
      expect(anyOf(key, ["submission:read", "submission:create", "placement:read"]), key).toBe(SEES_PARTIES.has(key));
    }
  });

  it.each(users)("returns only the lists the caller may see (%s)", async (key) => {
    const j = await lookups(key);
    expect(Object.keys(j).sort()).toEqual(["clients", "coaches", "implementationPartners", "locations", "technologies", "vendors"]);
    for (const list of Object.values(j)) {
      expect(Array.isArray(list)).toBe(true);
      for (const item of list) expect(Object.keys(item).sort()).toEqual(["id", "name"]);
    }

    // Open to everyone.
    expect(j.technologies!.map((t) => t.name)).toEqual(["Java"]); // inactive Cobol hidden
    expect(j.locations!.map((l) => l.id).sort()).toEqual([LOC.austin, LOC.dallas].sort());

    // Interview schedulers/editors only.
    expect(j.coaches).toEqual(SEES_COACHES.has(key) ? [{ id: U.coach, name: "coach" }] : []);

    // Submission/placement workers only.
    if (SEES_PARTIES.has(key)) {
      expect(j.clients!.map((c) => c.id)).toContain(CLIENT_ID);
      expect(j.vendors!.map((v) => v.name)).toContain("Acme Staffing");
      expect(j.implementationPartners!.map((v) => v.name)).toEqual(["Prime IP"]);
    } else {
      expect(j.clients).toEqual([]);
      expect(j.vendors).toEqual([]);
      expect(j.implementationPartners).toEqual([]);
    }
  });

  it("the coach and admin roles see neither restricted list", async () => {
    for (const key of ["coach", "admin", "imm"] as const) {
      const j = await lookups(key);
      expect([j.coaches, j.clients, j.vendors, j.implementationPartners]).toEqual([[], [], [], []]);
    }
  });

  it("requires a session", async () => {
    expect((await app.inject({ method: "GET", url: "/api/v1/lookups" })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/v1/lookups/technologies", payload: { name: "Go" } })).statusCode).toBe(401);
  });
});

describe("POST /api/v1/lookups/technologies", () => {
  const add = async (key: Key, payload: Record<string, unknown>) => {
    const cookie = await login(key);
    const me = await app.inject({ method: "GET", url: "/api/v1/me", headers: { cookie } });
    const csrf = me.json().csrfToken as string;
    return app.inject({ method: "POST", url: "/api/v1/lookups/technologies", headers: { cookie, "x-csrf-token": csrf }, payload });
  };

  it("lets any signed-in user add one, and everyone then sees it", async () => {
    const res = await add("coach", { name: "  Rust   Systems " });
    expect(res.statusCode, res.body).toBe(200);
    const made = res.json() as { id: string; name: string; created: boolean };
    expect(made).toMatchObject({ name: "Rust Systems", created: true });
    expect((await lookups("r1a")).technologies).toContainEqual({ id: made.id, name: "Rust Systems" });

    const audit = await db.admin.query(`SELECT actor_id, changes FROM eureka.audit_event WHERE action = 'technology.created' AND entity_id = $1`, [made.id]);
    expect(audit.rows).toEqual([{ actor_id: U.coach, changes: null }]);
  });

  it("returns the existing row for the same name in any case", async () => {
    const res = await add("r2a", { name: "jAVA" });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ name: "Java", created: false });
    const { rows } = await db.admin.query(`SELECT count(*)::int AS n FROM eureka.technology WHERE lower(name) = 'java'`);
    expect(rows[0].n).toBe(1);
  });

  it("refuses a retired name and bad input", async () => {
    expect((await add("r1a", { name: "cobol" })).statusCode).toBe(409);
    expect((await add("r1a", { name: "   " })).statusCode).toBe(422);
    expect((await add("r1a", { name: "x".repeat(61) })).statusCode).toBe(422);
    expect((await add("r1a", { name: "a\u0007b" })).statusCode).toBe(422);
    expect((await add("r1a", { name: "Go", active: false })).statusCode).toBe(422);
  });

  it("the app role can only write through the function", async () => {
    await expect(asUser(db.app, U.r1a, (c) => c.query(`INSERT INTO eureka.technology (name) VALUES ('Direct')`)))
      .rejects.toMatchObject({ code: "42501" });
  });

  it("refuses a caller who is not an active user", async () => {
    await expect(asUser(db.app, "00000000-0000-4000-8000-000000000000", (c) => c.query(`SELECT * FROM authz.create_technology('Go')`)))
      .rejects.toMatchObject({ code: "42501" });
  });
});

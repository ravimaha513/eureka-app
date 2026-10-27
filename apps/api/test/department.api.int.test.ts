import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.module.js";
import { loadConfig } from "../src/platform/config.js";
import { createTestDb, type TestDb } from "./db-harness.js";
import { T, U, seedFixtures } from "./fixtures.js";

/** Departments in Users & Access (docs/admin-api.md, Departments; migration 0230). */
let db: TestDb;
let app: NestFastifyApplication;
const SECRET = "test-secret-test-secret-test-secret-123";
const NIL = "00000000-0000-0000-0000-00000000beef";

beforeAll(async () => {
  db = await createTestDb();
  await seedFixtures(db.admin);
  const url = new URL(process.env.TEST_PG_ADMIN_URL ?? "postgres://postgres:postgres@127.0.0.1:5432");
  app = await createApp(loadConfig({
    NODE_ENV: "test",
    AUTH_MODE: "dev",
    SESSION_SECRET: SECRET,
    GOOGLE_HOSTED_DOMAIN: "eureka.example",
    DATABASE_URL: `postgres://eureka_app:eureka_app_test@${url.host}/${db.name}`,
  }));
}, 90_000);

afterAll(async () => {
  await app?.close();
  await db?.drop();
});

type Method = "GET" | "POST" | "PUT" | "PATCH";
const sessions = new Map<string, { cookie: string; csrf: string }>();

async function login(key: keyof typeof U) {
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

async function call(key: keyof typeof U, method: Method, url: string, payload?: unknown) {
  const s = await login(key);
  return app.inject({ method, url, payload: payload as never, headers: { cookie: s.cookie, ...(method !== "GET" ? { "x-csrf-token": s.csrf } : {}) } });
}

const audits = async (action: string) =>
  (await db.admin.query(`SELECT entity_id, changes FROM eureka.audit_event WHERE action = $1 ORDER BY seq`, [action])).rows;

describe("departments API", () => {
  let sales: string;
  let prep: string;

  it("is admin-only", async () => {
    for (const key of ["r1a", "l1", "m1", "ad", "ceo", "hr"] as const) {
      expect((await call(key, "GET", "/api/v1/admin/departments")).statusCode, key).toBe(403);
      expect((await call(key, "POST", "/api/v1/admin/departments", { name: "X" })).statusCode, key).toBe(403);
      expect((await call(key, "PATCH", `/api/v1/admin/departments/${NIL}`, { name: "X" })).statusCode, key).toBe(403);
      expect((await call(key, "PUT", `/api/v1/admin/users/${U.r1b}/department`, { departmentId: null })).statusCode, key).toBe(403);
    }
  });

  it("creates departments and sub-departments", async () => {
    let res = await call("admin", "POST", "/api/v1/admin/departments", { name: "Sales" });
    expect(res.statusCode).toBe(201);
    sales = res.json().id;
    res = await call("admin", "POST", "/api/v1/admin/departments", { name: "Interview Prep", parentId: sales });
    expect(res.statusCode).toBe(201);
    prep = res.json().id;

    expect((await call("admin", "POST", "/api/v1/admin/departments", { name: "sales" })).json()).toMatchObject({ status: 409, detail: "department_exists" });
    expect((await call("admin", "POST", "/api/v1/admin/departments", { name: "Deep", parentId: prep })).json()).toMatchObject({ status: 422, detail: "invalid_parent" });
    expect((await call("admin", "POST", "/api/v1/admin/departments", { name: "X", parentId: NIL })).statusCode).toBe(404);
    expect((await call("admin", "POST", "/api/v1/admin/departments", { name: "  " })).statusCode).toBe(422);

    const created = await audits("admin.department.created");
    expect(created.map((a) => a.changes)).toEqual([{ parentId: null }, { parentId: sales }]);
  });

  it("renames without putting the name in the audit row", async () => {
    expect((await call("admin", "PATCH", `/api/v1/admin/departments/${sales}`, { name: "Sales US" })).statusCode).toBe(204);
    expect((await call("admin", "PATCH", `/api/v1/admin/departments/${NIL}`, { name: "X" })).statusCode).toBe(404);
    const renamed = await audits("admin.department.renamed");
    expect(renamed).toHaveLength(1);
    expect(JSON.stringify(renamed)).not.toContain("Sales US");
  });

  it("sets a user's department and lists, filters and shows it", async () => {
    expect((await call("admin", "PUT", `/api/v1/admin/users/${U.coach}/department`, { departmentId: prep })).statusCode).toBe(204);
    expect((await call("admin", "PUT", `/api/v1/admin/users/${U.l1}/department`, { departmentId: sales })).statusCode).toBe(204);
    expect((await call("admin", "PUT", `/api/v1/admin/users/${NIL}/department`, { departmentId: sales })).statusCode).toBe(404);
    expect((await call("admin", "PUT", `/api/v1/admin/users/${U.l1}/department`, { departmentId: NIL })).statusCode).toBe(404);
    expect((await call("admin", "PUT", `/api/v1/admin/users/${U.l1}/department`, {})).statusCode).toBe(422);
    expect((await audits("admin.user.department")).map((a) => [a.entity_id, a.changes]))
      .toEqual([[U.coach, { departmentId: prep, previous: null }], [U.l1, { departmentId: sales, previous: null }]]);

    const list = (await call("admin", "GET", "/api/v1/admin/departments")).json().items;
    expect(list).toEqual([
      { id: prep, name: "Interview Prep", parentId: sales, userCount: 1 },
      { id: sales, name: "Sales US", parentId: null, userCount: 1 },
    ]);

    const users = async (q: string) =>
      ((await call("admin", "GET", `/api/v1/admin/users?limit=200${q}`)).json().items as { id: string; department: unknown }[]);
    const all = await users("");
    expect(all.find((u) => u.id === U.coach)!.department).toEqual({ id: prep, name: "Interview Prep", parent: { id: sales, name: "Sales US" } });
    expect(all.find((u) => u.id === U.l1)!.department).toEqual({ id: sales, name: "Sales US", parent: null });
    expect(all.find((u) => u.id === U.r1a)!.department).toBeNull();

    // A department includes its sub-departments.
    expect((await users(`&departmentId=${sales}`)).map((u) => u.id).sort()).toEqual([U.l1, U.coach].sort());
    expect((await users(`&departmentId=${prep}`)).map((u) => u.id)).toEqual([U.coach]);
    const none = (await users("&departmentId=none")).map((u) => u.id);
    expect(none).toContain(U.r1a);
    expect(none).not.toContain(U.l1);
    expect((await call("admin", "GET", "/api/v1/admin/users?departmentId=bogus")).statusCode).toBe(422);

    const teams = (await call("admin", "GET", "/api/v1/admin/teams")).json().items as { id: string; department: unknown }[];
    expect(teams.find((t) => t.id === T.t1)!.department).toEqual({ id: sales, name: "Sales US", parent: null });

    expect((await call("admin", "PUT", `/api/v1/admin/users/${U.coach}/department`, { departmentId: null })).statusCode).toBe(204);
    expect((await audits("admin.user.department")).at(-1)!.changes).toEqual({ departmentId: null, previous: prep });
  });

  it("does not change anyone's access", async () => {
    const access = async () => { const { roles, capabilities } = (await call("r3a", "GET", "/api/v1/me")).json(); return { roles, capabilities }; };
    const before = await access();
    expect((await call("admin", "PUT", `/api/v1/admin/users/${U.r3a}/department`, { departmentId: sales })).statusCode).toBe(204);
    sessions.delete("r3a");
    expect(await access()).toEqual(before);
  });
});

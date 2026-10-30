import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.module.js";
import { loadConfig } from "../src/platform/config.js";
import { createTestDb, type TestDb } from "./db-harness.js";
import { T, U, seedFixtures } from "./fixtures.js";

/** Org chart editor (docs/roles-api.md, "Org chart"): reporting-line batches with the ladder warning. */
let db: TestDb;
let app: NestFastifyApplication;
const SECRET = "test-secret-test-secret-test-secret-123";

beforeAll(async () => {
  db = await createTestDb();
  await seedFixtures(db.admin);
  const url = new URL(process.env.TEST_PG_ADMIN_URL ?? "postgres://postgres:postgres@127.0.0.1:5432");
  app = await createApp(loadConfig({
    NODE_ENV: "test", AUTH_MODE: "dev", SESSION_SECRET: SECRET, GOOGLE_HOSTED_DOMAIN: "eureka.example",
    DATABASE_URL: `postgres://eureka_app:eureka_app_test@${url.host}/${db.name}`,
  }));
}, 90_000);

afterAll(async () => {
  await app?.close();
  await db?.drop();
});

type Method = "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
const sessions = new Map<string, { cookie: string; csrf: string }>();
async function call(key: keyof typeof U, method: Method, url: string, payload?: unknown) {
  let s = sessions.get(key);
  if (!s) {
    const res = await app.inject({ method: "POST", url: "/api/auth/dev-login", payload: { email: `${key}@eureka.example` } });
    const cookie = String(res.headers["set-cookie"]).split(";")[0]!;
    const me = await app.inject({ method: "GET", url: "/api/v1/me", headers: { cookie } });
    s = { cookie, csrf: me.json().csrfToken as string };
    sessions.set(key, s);
  }
  return app.inject({ method, url, payload: payload as never, headers: { cookie: s.cookie, ...(method !== "GET" ? { "x-csrf-token": s.csrf } : {}) } });
}
const detail = (res: { json: () => { detail?: string } }) => res.json().detail;
const managerOf = async (id: string) =>
  (await db.admin.query<{ m: string }>(`SELECT manager_id AS m FROM eureka.reporting_line WHERE user_id = $1 AND valid @> now()`, [id])).rows[0]?.m ?? null;

describe("org chart", () => {
  it("lists active people with manager, roles (track, level) and team; the caller cannot be moved", async () => {
    const r = await call("admin", "GET", "/api/v1/admin/org-chart");
    expect(r.statusCode).toBe(200);
    const people = r.json().people as { id: string; managerId: string | null; roles: { key: string; track: string; level: number }[]; team: { id: string; name: string; asLead: boolean } | null; canMove: boolean }[];
    expect(people.find((p) => p.id === U.r1a)).toMatchObject({
      managerId: U.l1, roles: [{ key: "recruiter", label: "Recruiter", track: "sales", level: 1 }], team: { id: T.t1, name: "Team Rohit", asLead: false }, canMove: true,
    });
    expect(people.find((p) => p.id === U.l1)).toMatchObject({ managerId: U.m1, team: { id: T.t1, asLead: true } });
    expect(people.find((p) => p.id === U.ceo)).toMatchObject({ managerId: null, team: null });
    expect(people.find((p) => p.id === U.admin)).toMatchObject({ canMove: false });
    expect(r.json().teams).toEqual(expect.arrayContaining([{ id: T.t1, name: "Team Rohit", leadId: U.l1 }]));
    expect((await call("l1", "GET", "/api/v1/admin/org-chart")).statusCode).toBe(403);
  });

  it("previews who leaves and joins the reporting chain, with the ladder warning", async () => {
    // r1a (recruiter, L1) under l1 → under m2: loses l1 and m1, gains m2 (ad and ceo stay).
    let r = await call("admin", "GET", `/api/v1/admin/org-chart/preview?userId=${U.r1a}&managerId=${U.m2}`);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ loses: [{ id: U.l1, displayName: "l1" }, { id: U.m1, displayName: "m1" }], gains: [{ id: U.m2, displayName: "m2" }], warnings: [] });
    // Under a recruiter of the same level: allowed, warned.
    r = await call("admin", "GET", `/api/v1/admin/org-chart/preview?userId=${U.r1a}&managerId=${U.r2a}`);
    expect(r.json().warnings).toEqual(["ladder_level"]);
    // Cross-track: the interview lead (L2 of interview_prep) under the manager (L3 sales) compares highest levels: fine.
    r = await call("admin", "GET", `/api/v1/admin/org-chart/preview?userId=${U.il}&managerId=${U.m1}`);
    expect(r.json().warnings).toEqual([]);
    // No manager: everyone above leaves.
    r = await call("admin", "GET", `/api/v1/admin/org-chart/preview?userId=${U.l1}&managerId=`);
    expect(r.json()).toMatchObject({ loses: [{ id: U.ad }, { id: U.ceo }, { id: U.m1 }], gains: [], warnings: [] });
  });

  it("applies a batch all or nothing, audited per item, with ladder warnings returned", async () => {
    const r = await call("admin", "POST", "/api/v1/admin/org-chart/apply", {
      moves: [{ userId: U.r1a, managerId: U.l2 }, { userId: U.r1b, managerId: U.r2a }, { userId: U.l3, managerId: U.m2 }],
      teamAdds: [{ userId: U.r3a, teamId: T.t3 }].filter(() => false),
    });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toEqual({ applied: 3, warnings: [{ userId: U.r1b, code: "ladder_level" }] });
    expect(await managerOf(U.r1a)).toBe(U.l2);
    expect(await managerOf(U.r1b)).toBe(U.r2a);
    const audits = (await db.admin.query(`SELECT entity_id, changes FROM eureka.audit_event WHERE action = 'admin.user.manager' ORDER BY seq`)).rows;
    expect(audits).toEqual([
      { entity_id: U.r1a, changes: { managerId: U.l2, previous: U.l1, warnings: [], batch: true } },
      { entity_id: U.r1b, changes: { managerId: U.r2a, previous: U.l1, warnings: ["ladder_level"], batch: true } },
    ]); // l3 → m2 was already so: no change, no audit row
    // Hierarchy scope followed: l2 now sees r1a's work, l1 does not.
    expect((await db.admin.query(`SELECT 1 FROM eureka.reporting_closure WHERE ancestor_id = $1 AND descendant_id = $2`, [U.l2, U.r1a])).rowCount).toBe(1);
    expect((await db.admin.query(`SELECT 1 FROM eureka.reporting_closure WHERE ancestor_id = $1 AND descendant_id = $2`, [U.l1, U.r1a])).rowCount).toBe(0);

    // A cycle anywhere rolls the whole batch back.
    const bad = await call("admin", "POST", "/api/v1/admin/org-chart/apply", { moves: [{ userId: U.r2a, managerId: U.l3 }, { userId: U.m1, managerId: U.r1a }] });
    expect(detail(bad)).toBe("cycle");
    expect(await managerOf(U.r2a)).toBe(U.l2);
    expect(detail(await call("admin", "POST", "/api/v1/admin/org-chart/apply", { moves: [{ userId: U.r2a, managerId: null }, { userId: U.r2a, managerId: U.l1 }] }))).toBe("duplicate_user");
    expect((await call("admin", "POST", "/api/v1/admin/org-chart/apply", { moves: [{ userId: U.admin, managerId: U.ceo }] })).statusCode).toBe(403);
    expect((await call("admin", "POST", "/api/v1/admin/org-chart/apply", { moves: [] })).statusCode).toBe(422);
    expect((await call("hr", "POST", "/api/v1/admin/org-chart/apply", { moves: [{ userId: U.r2a, managerId: null }] })).statusCode).toBe(403);
  });

  it("adds unassigned recruiters to a team in the same batch; non-recruiters and members are refused", async () => {
    const r = await call("admin", "POST", "/api/v1/admin/org-chart/apply", { teamAdds: [{ userId: U.r3a, teamId: T.t3 }] });
    expect(detail(r)).toBe("already_member");
    expect(detail(await call("admin", "POST", "/api/v1/admin/org-chart/apply", { teamAdds: [{ userId: U.hr, teamId: T.t3 }] }))).toBe("not_a_recruiter");
    // A fresh recruiter with no team.
    const { id } = (await call("admin", "POST", "/api/v1/admin/users", { email: "newrec@eureka.example", displayName: "New Rec" })).json();
    expect((await call("admin", "POST", "/api/v1/admin/role-requests", { userId: id, role: "recruiter" })).statusCode).toBe(201);
    const ok = await call("admin", "POST", "/api/v1/admin/org-chart/apply", { moves: [{ userId: id, managerId: U.l3 }], teamAdds: [{ userId: id, teamId: T.t3 }] });
    expect(detail(ok)).toBe("duplicate_user"); // one user once per batch
    const ok2 = await call("admin", "POST", "/api/v1/admin/org-chart/apply", { teamAdds: [{ userId: id, teamId: T.t3 }] });
    expect(ok2.json()).toEqual({ applied: 1, warnings: [] });
    const chart = (await call("admin", "GET", "/api/v1/admin/org-chart")).json().people as { id: string; team: { id: string } | null }[];
    expect(chart.find((p) => p.id === id)!.team).toMatchObject({ id: T.t3 });
    expect((await db.admin.query(`SELECT changes FROM eureka.audit_event WHERE action = 'admin.team.member_added' ORDER BY seq DESC LIMIT 1`)).rows[0])
      .toEqual({ changes: { userId: id, batch: true } });
  });
});

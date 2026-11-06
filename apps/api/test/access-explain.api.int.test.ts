import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.module.js";
import { loadConfig } from "../src/platform/config.js";
import { asUser, createTestDb, type TestDb } from "./db-harness.js";
import { CLIENT_ID, T, U, seedFixtures, type FixtureCandidate } from "./fixtures.js";

/** AD-16 access explainer (docs/admin-api.md): engine paths per role, cross-checked against RLS as the user. */
let db: TestDb;
let app: NestFastifyApplication;
let candidates: FixtureCandidate[];
const SECRET = "test-secret-test-secret-test-secret-123";

beforeAll(async () => {
  db = await createTestDb();
  candidates = await seedFixtures(db.admin);
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

type Method = "GET" | "POST";
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
const explain = (userId: string, kind: string, id: string, as: keyof typeof U = "admin") =>
  call(as, "GET", `/api/v1/admin/access-explain?userId=${userId}&kind=${kind}&id=${id}`);

const find = (p: (c: FixtureCandidate) => boolean) => {
  const c = candidates.find(p);
  if (!c) throw new Error("fixture candidate missing");
  return c;
};

describe("access explainer", () => {
  it("explains a teammate's candidate through the team, with names and a matching RLS probe", async () => {
    const c = find((x) => x.teamId === T.t1 && x.recruiterId === U.r1b && x.visibility === "team" && x.marketingStatus === "active");
    const r = await explain(U.r1a, "candidate", c.id);
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body).toMatchObject({
      user: { id: U.r1a, displayName: "r1a" },
      permission: "candidate:read",
      allowed: true,
      rls: { allowed: true, agrees: true },
      record: { kind: "candidate", owner: { team: { id: T.t1, name: "Team Rohit" }, recruiter: { id: U.r1b, name: "r1b" } }, visibility: "team" },
    });
    expect(body.roles[0]).toMatchObject({ role: "recruiter", scope: "team" });
    expect(body.roles[0].paths).toContainEqual({ via: "team", on: "candidate", team: { id: T.t1, name: "Team Rohit" } });
    // Ids, team and user names only: no candidate name, phone or email in the answer.
    expect(JSON.stringify(body)).not.toMatch(/Cand\d|\+1469/);
  });

  it("explains a miss and the all-teams rule", async () => {
    const other = find((x) => x.teamId === T.t3 && x.visibility === "team" && x.marketingStatus === "active");
    let r = await explain(U.r1a, "candidate", other.id);
    expect(r.json()).toMatchObject({ allowed: false, rls: { allowed: false, agrees: true }, phone: "none" });
    expect(r.json().roles[0].miss).toBe("out_of_scope");

    const open = find((x) => x.teamId === T.t3 && x.visibility === "all_teams" && x.marketingStatus === "active");
    r = await explain(U.r1a, "candidate", open.id);
    expect(r.json()).toMatchObject({ allowed: true, rls: { agrees: true }, phone: "masked" });
    expect(r.json().roles[0].paths).toEqual([{ via: "all_teams" }]);

    const parked = find((x) => x.teamId === T.t3 && x.visibility === "all_teams" && x.marketingStatus === "on_hold");
    r = await explain(U.r1a, "candidate", parked.id);
    expect(r.json()).toMatchObject({ allowed: false, rls: { agrees: true } });
    expect(r.json().roles[0].miss).toBe("open_to_all_not_marketable");
  });

  it("explains a submission through the actor snapshot and the candidate owner", async () => {
    const c = find((x) => x.teamId === T.t1 && x.visibility === "team" && x.marketingStatus === "active");
    const created = await call("l1", "POST", "/api/v1/submissions", { candidateId: c.id, jobTitle: "Java Developer", clientId: CLIENT_ID });
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;
    const r = await explain(U.m1, "submission", id);
    expect(r.json()).toMatchObject({ permission: "submission:read", allowed: true, rls: { agrees: true }, record: { actor: { recruiter: { id: U.l1 } } } });
    expect((await explain(U.r3a, "submission", id)).json()).toMatchObject({ allowed: false, rls: { agrees: true } });
  });

  it("engine and RLS agree for every fixture user over a spread of candidates", async () => {
    const sample = candidates.filter((_, i) => i % 7 === 0);
    const disagreements: string[] = [];
    for (const key of Object.keys(U) as (keyof typeof U)[]) {
      for (const c of sample) {
        const b = (await explain(U[key], "candidate", c.id)).json();
        if (!b.rls?.agrees) disagreements.push(`${key} ${c.teamId} ${c.visibility} ${c.marketingStatus}: engine ${b.allowed} rls ${b.rls?.allowed}`);
      }
    }
    // Submissions by three leads, on their own and on all-teams candidates of other teams.
    const subs: string[] = [];
    for (const [lead, team] of [["l1", T.t1], ["l2", T.t2], ["l3", T.t3]] as const) {
      for (const c of [find((x) => x.teamId === team && x.marketingStatus === "active"),
        find((x) => x.teamId !== team && x.visibility === "all_teams" && x.marketingStatus === "active")]) {
        const r = await call(lead, "POST", "/api/v1/submissions", { candidateId: c.id, jobTitle: "Data Engineer", clientId: CLIENT_ID });
        if (r.statusCode === 201) subs.push(r.json().id as string);
      }
    }
    expect(subs.length).toBeGreaterThanOrEqual(3);
    for (const key of Object.keys(U) as (keyof typeof U)[]) {
      for (const id of subs) {
        const b = (await explain(U[key], "submission", id)).json();
        if (!b.rls?.agrees) disagreements.push(`${key} submission ${id}: engine ${b.allowed} rls ${b.rls?.allowed}`);
      }
    }
    expect(disagreements).toEqual([]);
  }, 180_000);

  it("audits with ids and verdicts only", async () => {
    const c = candidates[0]!;
    await explain(U.r2a, "candidate", c.id);
    const { rows } = await db.admin.query(
      `SELECT entity_type, changes FROM eureka.audit_event WHERE action = 'admin.access.explained' AND entity_id = $1 AND actor_id = $2
       ORDER BY at DESC LIMIT 1`, [c.id, U.admin]);
    expect(rows[0]).toMatchObject({ entity_type: "candidate", changes: { userId: U.r2a } });
    expect(Object.keys(rows[0].changes).sort()).toEqual(["allowed", "rlsAllowed", "userId"]);
  });

  it("is admin-only; unknown user or record is 404; bad input is 422", async () => {
    const c = candidates[0]!;
    expect((await explain(U.r1a, "candidate", c.id, "ceo")).statusCode).toBe(403);
    expect((await explain(U.r1a, "candidate", c.id, "l1")).statusCode).toBe(403);
    expect((await explain("00000000-0000-4000-8000-00000000ffff", "candidate", c.id)).statusCode).toBe(404);
    expect((await explain(U.r1a, "placement", c.id)).statusCode).toBe(404);
    expect((await explain(U.r1a, "hotlist", c.id)).statusCode).toBe(422);
  });
});

describe("authz.admin_explain_record", () => {
  it("refuses non-admins in the database too", async () => {
    const c = candidates[0]!;
    await expect(asUser(db.app, U.ceo, (cl) => cl.query(`SELECT * FROM authz.admin_explain_record('candidate', $1)`, [c.id])))
      .rejects.toThrow(/not_permitted/);
  });
});

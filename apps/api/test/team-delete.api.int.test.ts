import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.module.js";
import { loadConfig } from "../src/platform/config.js";
import { asUser, createTestDb, type TestDb } from "./db-harness.js";
import { LOC, T, TECH_ID, U, seedFixtures } from "./fixtures.js";

/**
 * Deleting a team (docs/admin-api.md AD-15, migration 0420): members and candidates move to
 * another team or are left with no team, and the deleted team grants nothing afterwards.
 */
let db: TestDb;
let app: NestFastifyApplication;
const SECRET = "test-secret-test-secret-test-secret-123";
const T4 = "00000000-0000-0000-0000-000000000104";

beforeAll(async () => {
  db = await createTestDb();
  await seedFixtures(db.admin);
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

async function call(key: keyof typeof U, method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: unknown) {
  const s = await login(key);
  return app.inject({ method, url, headers: { cookie: s.cookie, "x-csrf-token": s.csrf }, ...(payload !== undefined ? { payload: payload as object } : {}) });
}

let n = 0;
async function candidate(teamId: string, recruiterId: string | null, status: string) {
  n += 1;
  const p = await db.admin.query<{ id: string }>(
    `INSERT INTO eureka.person (first_name, last_name, phone_e164) VALUES ('Del', $1, $2) RETURNING id`,
    [`Team${n}`, `+1214555${String(1000 + n)}`]);
  return (await db.admin.query<{ id: string }>(
    `INSERT INTO eureka.candidate (person_id, technology_id, team_id, recruiter_id, location_id, visibility, marketing_status)
     VALUES ($1, $2, $3, $4, $5, 'team', $6) RETURNING id`,
    [p.rows[0]!.id, TECH_ID, teamId, recruiterId, LOC.dallas, status])).rows[0]!.id;
}

const cand = async (id: string) => (await db.admin.query<{ team_id: string | null; recruiter_id: string | null }>(
  `SELECT team_id, recruiter_id FROM eureka.candidate WHERE id = $1`, [id])).rows[0]!;
const teamsOf = async (userId: string) => (await db.admin.query<{ team_id: string }>(
  `SELECT team_id FROM eureka.team_member WHERE user_id = $1 AND valid @> now()`, [userId])).rows.map((r) => r.team_id);
const managerOf = async (userId: string) => (await db.admin.query<{ manager_id: string }>(
  `SELECT manager_id FROM eureka.reporting_line WHERE user_id = $1 AND valid @> now()`, [userId])).rows[0]?.manager_id;
const audits = async (action: string) =>
  (await db.admin.query(`SELECT actor_id, entity_id, changes FROM eureka.audit_event WHERE action = $1 ORDER BY seq`, [action])).rows;

describe("admin deletes a team (AD-15)", () => {
  it("needs access:manage", async () => {
    expect((await call("m1", "DELETE", `/api/v1/admin/teams/${T.t3}`)).statusCode).toBe(403);
    expect((await call("m1", "GET", `/api/v1/admin/teams/${T.t3}/delete-impact`)).statusCode).toBe(403);
  });

  it("refuses the same team, an unknown target and a bad id", async () => {
    const same = await call("admin", "DELETE", `/api/v1/admin/teams/${T.t3}?toTeamId=${T.t3}`);
    expect(same.statusCode).toBe(422);
    expect(same.json().detail).toBe("same_team");
    expect((await call("admin", "DELETE", `/api/v1/admin/teams/${T.t3}?toTeamId=00000000-0000-0000-0000-000000000000`)).statusCode).toBe(404);
    expect((await call("admin", "DELETE", `/api/v1/admin/teams/${T.t3}?toTeamId=nope`)).statusCode).toBe(422);
  });

  it("will not leave Hot List candidates without a team", async () => {
    const impact = await call("admin", "GET", `/api/v1/admin/teams/${T.t1}/delete-impact`);
    expect(impact.statusCode).toBe(200);
    expect(impact.json().members).toBe(2);
    expect(impact.json().hotlistCandidates).toBeGreaterThan(0);
    const res = await call("admin", "DELETE", `/api/v1/admin/teams/${T.t1}`);
    expect(res.statusCode).toBe(422);
    expect(res.json().detail).toBe("has_hotlist_candidates");
    expect(await teamsOf(U.r1a)).toEqual([T.t1]);
  });

  it("moves members and candidates to another team", async () => {
    const byLead = await candidate(T.t3, U.l3, "placed");
    const byMember = await candidate(T.t3, U.r3a, "active");
    const share = await candidate(T.t1, U.r1a, "placed");
    await asUser(db.app, U.l1, (c) => c.query("SELECT authz.set_candidate_visibility($1, 'selected_teams', $2::uuid[])", [share, [T.t3]]), true);
    expect((await db.admin.query(`SELECT 1 FROM eureka.candidate_team_share WHERE team_id = $1`, [T.t3])).rowCount).toBe(1);
    const before = (await call("admin", "GET", `/api/v1/admin/teams/${T.t3}/delete-impact`)).json();

    const res = await call("admin", "DELETE", `/api/v1/admin/teams/${T.t3}?toTeamId=${T.t2}`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ members: 1, movedCandidates: before.candidates, unassignedCandidates: 0 });

    expect(await teamsOf(U.r3a)).toEqual([T.t2]);
    expect(await managerOf(U.r3a)).toBe(U.l2);
    expect(await cand(byMember)).toEqual({ team_id: T.t2, recruiter_id: U.r3a });
    expect(await cand(byLead)).toEqual({ team_id: T.t2, recruiter_id: U.l2 });
    expect((await db.admin.query(`SELECT 1 FROM eureka.candidate WHERE team_id = $1`, [T.t3])).rowCount).toBe(0);
    expect((await db.admin.query(`SELECT 1 FROM eureka.candidate_team_share WHERE team_id = $1`, [T.t3])).rowCount).toBe(0);
    expect((await db.admin.query(`SELECT lead_id, deleted_at IS NOT NULL AS deleted FROM eureka.team WHERE id = $1`, [T.t3])).rows[0])
      .toEqual({ lead_id: null, deleted: true });
    expect((await audits("admin.team.deleted")).at(-1)).toMatchObject({
      actor_id: U.admin, entity_id: T.t3, changes: { toTeamId: T.t2, members: 1, unassignedCandidates: 0 },
    });

    // Gone from the Teams tab, and nothing more can be done to it.
    const list = (await call("admin", "GET", "/api/v1/admin/teams")).json();
    expect(list.items.map((t: { id: string }) => t.id)).not.toContain(T.t3);
    expect((await call("admin", "DELETE", `/api/v1/admin/teams/${T.t3}`)).statusCode).toBe(404);
    expect((await call("admin", "PATCH", `/api/v1/admin/teams/${T.t3}`, { name: "Back" })).statusCode).toBe(404);
    expect((await call("admin", "POST", `/api/v1/admin/teams/${T.t3}/members`, { userId: U.l3 })).statusCode).toBe(404);
    expect((await call("admin", "POST", `/api/v1/admin/teams/${T.t3}/members/bulk`, { userIds: [U.l3] })).statusCode).toBe(404);
    await expect(db.admin.query(`INSERT INTO eureka.coach_assignment (coach_id, team_id) VALUES ($1, $2)`, [U.coach, T.t3]))
      .rejects.toThrow("team_not_found");
    await expect(candidate(T.t3, null, "placed")).rejects.toThrow("team_not_found");

    // The old lead leads nothing now: no team scope, and they can be deactivated.
    const me = (await call("l3", "GET", "/api/v1/me")).json();
    expect(JSON.stringify(me)).not.toContain(T.t3);
    expect((await call("admin", "POST", `/api/v1/admin/users/${U.l3}/deactivate`)).statusCode).not.toBe(422);
  });

  it("leaves members and candidates with no team", async () => {
    await db.admin.query(`INSERT INTO eureka.team (id, name, lead_id) VALUES ($1, 'Team Spare', $2)`, [T4, U.m2]);
    await db.admin.query(`UPDATE eureka.team_member SET valid = tstzrange(lower(valid), now()) WHERE user_id = $1 AND valid @> now()`, [U.r3a]);
    await db.admin.query(`INSERT INTO eureka.team_member (team_id, user_id) VALUES ($1, $2)`, [T4, U.r3a]);
    const c = await candidate(T4, U.r3a, "placed");
    await db.admin.query(`INSERT INTO eureka.coach_assignment (coach_id, team_id) VALUES ($1, $2)`, [U.coach, T4]);

    const res = await call("admin", "DELETE", `/api/v1/admin/teams/${T4}`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ members: 1, movedCandidates: 0, unassignedCandidates: 1 });
    expect(await teamsOf(U.r3a)).toEqual([]);
    expect(await managerOf(U.r3a)).toBe(U.m2);
    expect(await cand(c)).toEqual({ team_id: null, recruiter_id: U.r3a });
    expect((await db.admin.query(`SELECT 1 FROM eureka.coach_assignment WHERE team_id = $1 AND valid @> now()`, [T4])).rowCount).toBe(0);
    expect((await call("admin", "GET", "/api/v1/admin/teams")).json().unassignedCount).toBeGreaterThan(0);
  });

  it("refuses moving people under the acting admin (AD-2)", async () => {
    await db.admin.query(`INSERT INTO eureka.team (id, name, lead_id) VALUES ('00000000-0000-0000-0000-000000000105', 'Team Admin', $1)`, [U.admin]);
    const own = await call("admin", "DELETE", `/api/v1/admin/teams/${T.t2}?toTeamId=00000000-0000-0000-0000-000000000105`);
    expect(own.statusCode).toBe(403);
    expect(own.json().detail).toBe("self_change");
  });
});

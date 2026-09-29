import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isRestrictedRole, ROLES } from "@eureka/shared";
import { asUser, createTestDb, type TestDb } from "./db-harness.js";
import { LOC, T, U, seedFixtures, type FixtureCandidate } from "./fixtures.js";

/**
 * Database-level tests for migration 0013: the admin definer functions hold on
 * their own, called directly as eureka_app, without the API in front.
 */
let db: TestDb;
let candidates: FixtureCandidate[];

beforeAll(async () => {
  db = await createTestDb();
  candidates = await seedFixtures(db.admin);
}, 90_000);

afterAll(async () => {
  await db?.drop();
});

const NIL = "00000000-0000-0000-0000-00000000beef";

describe("privileges", () => {
  it("role.is_restricted is seeded from the catalog", async () => {
    const { rows } = await db.admin.query<{ key: string; is_restricted: boolean }>(`SELECT key, is_restricted FROM eureka.role`);
    expect(rows).toHaveLength(ROLES.length);
    for (const r of rows) expect(r.is_restricted, r.key).toBe(isRestrictedRole(r.key as (typeof ROLES)[number]));
  });

  it.each([
    [`INSERT INTO eureka.user_role (user_id, role_key) VALUES ('${U.r1a}', 'hr')`],
    [`UPDATE eureka.user_role SET valid = tstzrange(now(), now())`],
    [`UPDATE eureka.app_user SET status = 'inactive' WHERE id = '${U.r1a}'`],
    [`INSERT INTO eureka.app_user (email, display_name) VALUES ('x@eureka.example', 'x')`],
    [`INSERT INTO eureka.team_member (team_id, user_id) VALUES ('${T.t1}', '${U.hr}')`],
    [`INSERT INTO eureka.team (name, lead_id) VALUES ('x', '${U.l1}')`],
    [`INSERT INTO eureka.reporting_line (user_id, manager_id) VALUES ('${U.hr}', '${U.ceo}')`],
    [`INSERT INTO eureka.role_request (user_id, role_key, requested_by) VALUES ('${U.r1a}', 'hr', '${U.admin}')`],
    [`UPDATE eureka.role_request SET status = 'approved'`],
  ])("even an admin cannot write org tables directly: %s", async (sql) => {
    await expect(asUser(db.app, U.admin, (c) => c.query(sql))).rejects.toThrow(/permission denied/);
  });

  it("internal helpers are not executable by the API role", async () => {
    for (const sql of [`SELECT authz.admin_guard(NULL)`, `SELECT authz.admin_user_status($1)`, `SELECT authz.ended(tstzrange(now(), NULL))`]) {
      await expect(asUser(db.app, U.admin, (c) => c.query(sql, sql.includes("$1") ? [U.r1a] : []))).rejects.toThrow(/permission denied/);
    }
  });

  it("role requests are readable only with access:manage", async () => {
    await asUser(db.app, U.admin, (c) => c.query(`SELECT * FROM authz.request_role($1, 'recruiter', NULL)`, [U.coach]), true);
    const admin = await asUser(db.app, U.admin, async (c) => (await c.query(`SELECT count(*)::int n FROM eureka.role_request`)).rows[0].n);
    expect(admin).toBeGreaterThan(0);
    for (const u of [U.r1a, U.ceo, U.hr, U.om]) {
      const n = await asUser(db.app, u, async (c) => (await c.query(`SELECT count(*)::int n FROM eureka.role_request`)).rows[0].n);
      expect(n, u).toBe(0);
    }
  });
});

describe("definer functions refuse callers without access:manage", () => {
  const calls: [string, unknown[]][] = [
    [`SELECT authz.admin_create_user('new@eureka.example', 'New', NULL, NULL)`, []],
    [`SELECT authz.admin_set_user_status($1, false)`, [U.r1b]],
    [`SELECT authz.admin_set_user_status($1, true)`, [U.r1b]],
    [`SELECT authz.admin_set_manager($1, $2)`, [U.r1b, U.l2]],
    [`SELECT * FROM authz.request_role($1, 'recruiter', NULL)`, [U.hr]],
    [`SELECT authz.approve_role_request($1)`, [NIL]],
    [`SELECT authz.reject_role_request($1)`, [NIL]],
    [`SELECT authz.revoke_role($1, 'recruiter', NULL)`, [U.r1b]],
    [`SELECT authz.admin_create_team('X', $1, NULL)`, [U.l1]],
    [`SELECT authz.admin_set_team_lead($1, $2)`, [T.t1, U.l2]],
    [`SELECT authz.admin_add_team_member($1, $2)`, [T.t1, U.hr]],
  ];
  // Every non-admin fixture user, including the org-scoped CEO and offshore manager.
  const actors = [U.r1a, U.l1, U.m1, U.om, U.ceo, U.hr, U.locD, "00000000-0000-0000-0000-00000000dead"];
  it.each(calls)("%s", async (sql, params) => {
    for (const actor of actors) {
      await expect(asUser(db.app, actor, (c) => c.query(sql, params)), actor).rejects.toThrow(/not_permitted/);
    }
  });

  it("with no user context", async () => {
    await expect(db.app.query(`SELECT authz.admin_set_user_status($1, false)`, [U.r1b])).rejects.toThrow(/not_permitted/);
  });

  it("move_team_member needs team:move_member", async () => {
    for (const actor of [U.admin, U.l1, U.r1a, U.ceo]) {
      await expect(asUser(db.app, actor, (c) => c.query(`SELECT * FROM authz.move_team_member($1, $2, $3, NULL)`, [U.r1b, T.t1, T.t2])), actor)
        .rejects.toThrow(/not_permitted/);
    }
  });
});

describe("self-change (AD-2)", () => {
  it.each([
    [`SELECT authz.admin_set_user_status($1, false)`, [U.admin]],
    [`SELECT authz.admin_set_manager($1, $2)`, [U.admin, U.ceo]],
    [`SELECT authz.admin_set_manager($1, $2)`, [U.r1a, U.admin]],
    [`SELECT * FROM authz.request_role($1, 'hr', NULL)`, [U.admin]],
    [`SELECT authz.revoke_role($1, 'org_admin', NULL)`, [U.admin]],
    [`SELECT authz.admin_create_team('Mine', $1, NULL)`, [U.admin]],
    [`SELECT authz.admin_set_team_lead($1, $2)`, [T.t1, U.admin]],
    [`SELECT authz.admin_add_team_member($1, $2)`, [T.t1, U.admin]],
  ])("%s %j", async (sql, params) => {
    await expect(asUser(db.app, U.admin, (c) => c.query(sql, params))).rejects.toThrow(/self_change/);
  });

  it("a manager cannot move themselves", async () => {
    await expect(asUser(db.app, U.m1, (c) => c.query(`SELECT * FROM authz.move_team_member($1, $2, $3, NULL)`, [U.m1, T.t1, T.t2])))
      .rejects.toThrow(/self_change/);
  });
});

describe("role requests (AD-3, AD-6)", () => {
  const request = (actor: string, user: string, role: string, loc: string | null = null) =>
    asUser(db.app, actor, async (c) =>
      (await c.query<{ request_id: string; request_status: string }>(`SELECT * FROM authz.request_role($1, $2, $3)`, [user, role, loc])).rows[0]!, true);
  const approve = (actor: string, id: string) =>
    asUser(db.app, actor, async (c) => (await c.query(`SELECT authz.approve_role_request($1) AS s`, [id])).rows[0].s, true);
  const holds = async (user: string, role: string) =>
    (await db.admin.query(`SELECT count(*)::int n FROM eureka.user_role WHERE user_id = $1 AND role_key = $2 AND valid @> now()`, [user, role])).rows[0].n > 0;

  it("a non-restricted role applies immediately", async () => {
    const r = await request(U.admin, U.coach, "documents_team");
    expect(r.request_status).toBe("applied");
    expect(await holds(U.coach, "documents_team")).toBe(true);
  });

  it("a restricted role waits for a second admin who is neither requester nor grantee", async () => {
    const r = await request(U.admin, U.r2a, "hr");
    expect(r.request_status).toBe("pending_approval");
    expect(await holds(U.r2a, "hr")).toBe(false);
    await expect(approve(U.admin, r.request_id)).rejects.toThrow(/second_approver_required/);
    await expect(approve(U.r2a, r.request_id)).rejects.toThrow(/not_permitted/);
    await expect(request(U.admin2, U.r2a, "hr")).rejects.toThrow(/request_pending/);
    expect(await approve(U.admin2, r.request_id)).toBe("approved");
    expect(await holds(U.r2a, "hr")).toBe(true);
    const { rows } = await db.admin.query(
      `SELECT created_by, approved_by FROM eureka.user_role WHERE user_id = $1 AND role_key = 'hr'`, [U.r2a]);
    expect(rows[0]).toEqual({ created_by: U.admin, approved_by: U.admin2 });
    await expect(approve(U.admin2, r.request_id)).rejects.toThrow(/request_not_pending/);
  });

  it("the grantee cannot approve their own org_admin request", async () => {
    await asUser(db.app, U.admin, (c) => c.query(`SELECT authz.revoke_role($1, 'org_admin', NULL)`, [U.admin2]), true);
    await request(U.admin, U.admin2, "org_admin").then(async (r) => {
      // admin2 no longer holds access:manage after the revocation.
      await expect(approve(U.admin2, r.request_id)).rejects.toThrow(/not_permitted/);
      await expect(approve(U.admin, r.request_id)).rejects.toThrow(/second_approver_required/);
    });
    // Restore admin2 directly (a third admin would approve in real life).
    await db.admin.query(`INSERT INTO eureka.user_role (user_id, role_key) VALUES ($1, 'org_admin')`, [U.admin2]);
    const again = (await db.admin.query(`SELECT id FROM eureka.role_request WHERE user_id = $1 AND status = 'pending'`, [U.admin2])).rows[0].id;
    await expect(approve(U.admin2, again)).rejects.toThrow(/second_approver_required/);
  });

  it("a pending request expires after 7 days", async () => {
    const r = await request(U.admin, U.r3a, "immigration");
    const { rows } = await db.admin.query(`SELECT expires_at - requested_at AS ttl FROM eureka.role_request WHERE id = $1`, [r.request_id]);
    expect(rows[0].ttl).toEqual({ days: 7 });
    await db.admin.query(`UPDATE eureka.role_request SET requested_at = now() - interval '8 days', expires_at = now() - interval '1 day' WHERE id = $1`, [r.request_id]);
    await expect(approve(U.admin2, r.request_id)).rejects.toThrow(/request_expired/);
    // A new request supersedes the expired one.
    const again = await request(U.admin, U.r3a, "immigration");
    expect(again.request_status).toBe("pending_approval");
    const old = await db.admin.query(`SELECT status FROM eureka.role_request WHERE id = $1`, [r.request_id]);
    expect(old.rows[0].status).toBe("expired");
  });

  it("the user_role CHECK backs the second-approver rule even for direct inserts", async () => {
    await expect(db.admin.query(`INSERT INTO eureka.user_role (user_id, role_key, created_by, approved_by) VALUES ($1, 'hr', $2, $2)`, [U.r3a, U.admin]))
      .rejects.toThrow(/check constraint/);
  });

  it("location-bound roles need a location; other roles reject one", async () => {
    await expect(request(U.admin, U.r3a, "location_incharge")).rejects.toThrow(/location_required/);
    await expect(request(U.admin, U.r3a, "recruiter", LOC.dallas)).rejects.toThrow(/location_not_allowed/);
    const ok = await request(U.admin, U.r3a, "location_incharge", LOC.dallas);
    expect(ok.request_status).toBe("applied");
    await expect(request(U.admin, U.r3a, "location_incharge", LOC.dallas)).rejects.toThrow(/role_already_held/);
  });

  it("revocation is immediate", async () => {
    await asUser(db.app, U.admin, (c) => c.query(`SELECT authz.revoke_role($1, 'location_incharge', $2)`, [U.r3a, LOC.dallas]), true);
    expect(await holds(U.r3a, "location_incharge")).toBe(false);
    await expect(asUser(db.app, U.admin, (c) => c.query(`SELECT authz.revoke_role($1, 'location_incharge', NULL)`, [U.r3a])))
      .rejects.toThrow(/role_not_held/);
  });
});

describe("deactivation (AD-5)", () => {
  it("ends roles, team and coach rows, revokes sessions and bumps access_version", async () => {
    await db.admin.query(
      `INSERT INTO eureka.session (id_hash, user_id, expires_at, auth_time, access_version)
       VALUES ('\\x01', $1, now() + interval '1 hour', now(), 1), ('\\x02', $2, now() + interval '1 hour', now(), 1)`, [U.coach, U.r1b]);
    const before = (await db.admin.query(`SELECT access_version FROM eureka.app_user WHERE id = $1`, [U.coach])).rows[0].access_version;
    await asUser(db.app, U.admin, (c) => c.query(`SELECT authz.admin_set_user_status($1, false)`, [U.coach]), true);
    const u = (await db.admin.query(`SELECT status, access_version FROM eureka.app_user WHERE id = $1`, [U.coach])).rows[0];
    expect(u.status).toBe("inactive");
    expect(u.access_version).toBeGreaterThan(before);
    const open = await db.admin.query(`
      SELECT (SELECT count(*) FROM eureka.user_role WHERE user_id = $1 AND valid @> now())::int AS roles,
             (SELECT count(*) FROM eureka.coach_assignment WHERE coach_id = $1 AND valid @> now())::int AS coach,
             (SELECT count(*) FROM eureka.session WHERE user_id = $1 AND revoked_at IS NULL)::int AS sessions,
             (SELECT count(*) FROM eureka.session WHERE user_id = $2 AND revoked_at IS NULL)::int AS other_sessions`, [U.coach, U.r1b]);
    expect(open.rows[0]).toEqual({ roles: 0, coach: 0, sessions: 0, other_sessions: 1 });

    await asUser(db.app, U.admin, (c) => c.query(`SELECT authz.admin_set_user_status($1, true)`, [U.coach]), true);
    const back = await db.admin.query(`SELECT status, (SELECT count(*)::int FROM eureka.user_role WHERE user_id = $1 AND valid @> now()) AS roles
      FROM eureka.app_user WHERE id = $1`, [U.coach]);
    expect(back.rows[0]).toEqual({ status: "active", roles: 0 });
  });

  it("ends team membership", async () => {
    await asUser(db.app, U.admin, (c) => c.query(`SELECT authz.admin_set_user_status($1, false)`, [U.r3a]), true);
    const n = (await db.admin.query(`SELECT count(*)::int n FROM eureka.team_member WHERE user_id = $1 AND valid @> now()`, [U.r3a])).rows[0].n;
    expect(n).toBe(0);
  });
});

describe("reporting lines and teams (AD-9)", () => {
  it("cycles are rejected", async () => {
    await expect(asUser(db.app, U.admin, (c) => c.query(`SELECT authz.admin_set_manager($1, $2)`, [U.ceo, U.r1a])))
      .rejects.toThrow(/cycle/);
  });

  it("changing a manager rebuilds the closure", async () => {
    await asUser(db.app, U.admin, (c) => c.query(`SELECT authz.admin_set_manager($1, $2)`, [U.l2, U.m2]), true);
    const { rows } = await db.admin.query(`SELECT ancestor_id FROM eureka.reporting_closure WHERE descendant_id = $1 ORDER BY depth`, [U.r2a]);
    expect(rows.map((r) => r.ancestor_id)).toEqual([U.l2, U.m2, U.ad, U.om, U.ceo]);
    await asUser(db.app, U.admin, (c) => c.query(`SELECT authz.admin_set_manager($1, $2)`, [U.l2, U.m1]), true);
  });

  it("a user already in a team cannot be added to another", async () => {
    await expect(asUser(db.app, U.admin, (c) => c.query(`SELECT authz.admin_add_team_member($1, $2)`, [T.t2, U.r1a])))
      .rejects.toThrow(/already_member/);
  });
});

describe("move member (OD-07, AD-8)", () => {
  const move = (actor: string, user: string, from: string, to: string, reassign: string | null = null) =>
    asUser(db.app, actor, async (c) =>
      (await c.query<{ moved_candidates: number; reassigned_to: string }>(
        `SELECT * FROM authz.move_team_member($1, $2, $3, $4)`, [user, from, to, reassign])).rows[0]!, true);

  it("refuses teams outside the actor's scope", async () => {
    await expect(move(U.m2, U.r1b, T.t1, T.t3)).rejects.toThrow(/not_in_scope/);
    await expect(move(U.m1, U.r1b, T.t1, T.t3)).rejects.toThrow(/not_in_scope/);
  });

  it("refuses a reassign target outside the old team", async () => {
    await expect(move(U.m1, U.r1a, T.t1, T.t2, U.r2a)).rejects.toThrow(/invalid_reassign_target/);
    await expect(move(U.m1, U.r1a, T.t1, T.t2, U.r1a)).rejects.toThrow(/invalid_reassign_target/);
  });

  it("moves the member and hands their candidates to the old team's lead by default", async () => {
    const mine = candidates.filter((c) => c.teamId === T.t1 && c.recruiterId === U.r1a).map((c) => c.id);
    const r = await move(U.m1, U.r1a, T.t1, T.t2);
    expect(r).toEqual({ moved_candidates: mine.length, reassigned_to: U.l1 });
    const { rows } = await db.admin.query(`SELECT DISTINCT recruiter_id, team_id FROM eureka.candidate WHERE id = ANY($1::uuid[])`, [mine]);
    expect(rows).toEqual([{ recruiter_id: U.l1, team_id: T.t1 }]);
    const teams = await db.admin.query(`SELECT team_id FROM eureka.team_member WHERE user_id = $1 AND valid @> now()`, [U.r1a]);
    expect(teams.rows).toEqual([{ team_id: T.t2 }]);
  });

  it("an org-scoped holder can move anyone; the chosen recruiter must be active in the old team", async () => {
    await expect(move(U.om, U.r1b, T.t1, T.t3, U.r1a)).rejects.toThrow(/invalid_reassign_target/);
    const r = await move(U.om, U.r2a, T.t2, T.t3, U.r1a);
    expect(r.reassigned_to).toBe(U.r1a);
  });
});

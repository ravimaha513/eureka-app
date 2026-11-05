import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ADMIN_COMPATIBLE_PERMISSIONS, ADMIN_PERMISSIONS, isRestrictedRole, ROLES } from "@eureka/shared";
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
    for (const u of [U.r1a, U.ceo, U.hr]) {
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
    [`SELECT authz.admin_rename_team($1, 'X')`, [T.t1]],
    [`SELECT authz.admin_rename_location($1, 'X')`, [LOC.dallas]],
    [`SELECT authz.admin_add_team_member($1, $2)`, [T.t1, U.hr]],
  ];
  // Non-admin fixture users, including the org-scoped CEO and the top of the Sales hierarchy.
  const actors = [U.r1a, U.l1, U.m1, U.ad, U.ceo, U.hr, U.locD, "00000000-0000-0000-0000-00000000dead"];
  it.each(calls)("%s", async (sql, params) => {
    for (const actor of actors) {
      await expect(asUser(db.app, actor, (c) => c.query(sql, params)), actor).rejects.toThrow(/not_permitted/);
    }
  });

  it("with no user context", async () => {
    await expect(db.app.query(`SELECT authz.admin_set_user_status($1, false)`, [U.r1b])).rejects.toThrow(/not_permitted/);
  });

  it("team_add_member needs team:add_member and the actor's own team (AD-10)", async () => {
    const sql = `SELECT authz.team_add_member($1, $2)`;
    for (const actor of [U.admin, U.r1a, U.ceo]) {
      await expect(asUser(db.app, actor, (c) => c.query(sql, [T.t1, U.hr])), actor).rejects.toThrow(/not_permitted/);
    }
    await expect(asUser(db.app, U.l1, (c) => c.query(sql, [T.t2, U.hr]))).rejects.toThrow(/not_in_scope/);
    // Manager: hierarchy scope covers t1 and t2 (leads l1, l2), not t3.
    await expect(asUser(db.app, U.m1, (c) => c.query(sql, [T.t3, U.hr]))).rejects.toThrow(/not_in_scope/);
    await expect(asUser(db.app, U.m1, (c) => c.query(sql, [T.t2, U.hr]))).rejects.toThrow(/not_a_recruiter/);
    await expect(asUser(db.app, U.l1, (c) => c.query(sql, [T.t1, U.hr]))).rejects.toThrow(/not_a_recruiter/);
    await expect(db.app.query(sql, [T.t1, U.hr])).rejects.toThrow(/not_permitted/);
  });

  it("move_team_member needs team:move_member", async () => {
    for (const actor of [U.admin, U.l1, U.r1a, U.ceo]) {
      await expect(asUser(db.app, actor, (c) => c.query(`SELECT * FROM authz.move_team_member($1, $2, $3, NULL)`, [U.r1b, T.t1, T.t2])), actor)
        .rejects.toThrow(/not_permitted/);
    }
  });
});

describe("single-admin mode (migration 0084)", () => {
  const request = (actor: string, user: string, role: string) =>
    asUser(db.app, actor, async (c) =>
      (await c.query<{ request_id: string; request_status: string }>(`SELECT * FROM authz.request_role($1, $2, NULL)`, [user, role])).rows[0]!, true);
  const approve = (actor: string, id: string) =>
    asUser(db.app, actor, async (c) => (await c.query(`SELECT authz.approve_role_request($1) AS s`, [id])).rows[0].s, true);
  const setMode = (v: "on" | "off") =>
    db.admin.query(`INSERT INTO authz.policy_setting (key, value) VALUES ('single_admin_mode', $1)
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [v]);
  const holds = async (user: string, role: string) =>
    (await db.admin.query(`SELECT count(*)::int n FROM eureka.user_role WHERE user_id = $1 AND role_key = $2 AND valid @> now()`, [user, role])).rows[0].n > 0;

  it("off by default: a restricted role stays pending", async () => {
    const r = await request(U.admin, U.r1b, "accounts");
    expect(r.request_status).toBe("pending_approval");
    expect(await holds(U.r1b, "accounts")).toBe(false);
  });

  it("on: a restricted role applies at once and the requester can approve a pending request", async () => {
    const pending = (await db.admin.query(`SELECT id FROM eureka.role_request WHERE user_id = $1 AND role_key = 'accounts' AND status = 'pending'`, [U.r1b])).rows[0].id;
    await setMode("on");
    try {
      expect(await approve(U.admin, pending)).toBe("approved");
      expect(await holds(U.r1b, "accounts")).toBe(true);
      const direct = await request(U.admin, U.r3a, "hr");
      expect(direct.request_status).toBe("applied");
      expect(await holds(U.r3a, "hr")).toBe(true);
      const { rows } = await db.admin.query(`SELECT created_by, approved_by FROM eureka.user_role WHERE user_id = $1 AND role_key = 'hr'`, [U.r3a]);
      expect(rows[0]).toEqual({ created_by: U.admin, approved_by: null });
      // Still no self-grant, and the grantee never approves.
      await expect(request(U.admin, U.admin, "hr")).rejects.toThrow(/self_change/);
    } finally {
      await setMode("off");
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
    const r = await request(U.admin, U.coach, "lead");
    expect(r.request_status).toBe("applied");
    expect(await holds(U.coach, "lead")).toBe(true);
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
    expect(rows.map((r) => r.ancestor_id)).toEqual([U.l2, U.m2, U.ad, U.ceo]);
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

  it("a holder whose hierarchy covers both teams can move anyone; the chosen recruiter must be active in the old team", async () => {
    await expect(move(U.ad, U.r1b, T.t1, T.t3, U.r1a)).rejects.toThrow(/invalid_reassign_target/);
    const r = await move(U.ad, U.r2a, T.t2, T.t3, U.r1a);
    expect(r.reassigned_to).toBe(U.r1a);
  });
});

describe("safety rails (migration 0014)", () => {
  it("a team lead cannot be deactivated until the team has a new lead", async () => {
    await expect(asUser(db.app, U.admin, (c) => c.query(`SELECT authz.admin_set_user_status($1, false)`, [U.l2])))
      .rejects.toThrow(/lead_of_team/);
  });

  it("the rail refuses a state with no active org_admin (defence in depth: self-change already keeps the actor)", async () => {
    const c = await db.admin.connect();
    try {
      await c.query("BEGIN");
      await c.query(`UPDATE eureka.user_role SET valid = tstzrange(lower(valid), now()) WHERE role_key = 'org_admin'`);
      await expect(c.query(`SELECT authz.assert_admin_remains()`)).rejects.toThrow(/last_admin/);
    } finally {
      await c.query("ROLLBACK");
      c.release();
    }
  });

  it("an admin can revoke another admin while one remains", async () => {
    await asUser(db.app, U.admin, (c) => c.query(`SELECT authz.revoke_role($1, 'org_admin', NULL)`, [U.admin2]));
  });
});

describe("security review follow-ups (migration 0018)", () => {
  it("a request cannot be approved after the grantee was deactivated, and deactivation closes it", async () => {
    const { rows } = await asUser(db.app, U.admin, (c) => c.query(`SELECT * FROM authz.request_role($1, 'hr', NULL)`, [U.r3a]), true);
    const id = rows[0].request_id;
    await asUser(db.app, U.admin, (c) => c.query(`SELECT authz.admin_set_user_status($1, false)`, [U.r3a]), true);
    const st = (await db.admin.query(`SELECT status FROM eureka.role_request WHERE id = $1`, [id])).rows[0].status;
    expect(st).toBe("rejected");
    await expect(asUser(db.app, U.admin2, (c) => c.query(`SELECT authz.approve_role_request($1)`, [id])))
      .rejects.toThrow(/request_not_pending|user_inactive/);
    await asUser(db.app, U.admin, (c) => c.query(`SELECT authz.admin_set_user_status($1, true)`, [U.r3a]), true);
    const roles = (await db.admin.query(`SELECT count(*)::int n FROM eureka.user_role WHERE user_id = $1 AND valid @> now()`, [U.r3a])).rows[0].n;
    expect(roles).toBe(0);
  });

  it("org-wide sensitive roles (e.g. ceo) need a second approver", async () => {
    const { rows } = await asUser(db.app, U.admin, (c) => c.query(`SELECT * FROM authz.request_role($1, 'ceo', NULL)`, [U.hr]), true);
    expect(rows[0].request_status).toBe("pending_approval");
  });

  it("separation of duties: an admin cannot also hold a data role", async () => {
    await expect(asUser(db.app, U.admin, (c) => c.query(`SELECT * FROM authz.request_role($1, 'recruiter', NULL)`, [U.admin2])))
      .rejects.toThrow(/separation_of_duties/);
    await expect(asUser(db.app, U.admin, (c) => c.query(`SELECT * FROM authz.request_role($1, 'org_admin', NULL)`, [U.l1])))
      .rejects.toThrow(/separation_of_duties/);
  });

  it("a manager with direct reports cannot be deactivated", async () => {
    await expect(asUser(db.app, U.admin, (c) => c.query(`SELECT authz.admin_set_user_status($1, false)`, [U.m1])))
      .rejects.toThrow(/has_reports|lead_of_team/);
  });
});

describe("admin separation and role versions (migrations 0500, 0501)", () => {
  /** Runs fn as eureka_app for actor after setup as the owner, all rolled back. */
  async function withSetup<T>(setup: string[], actor: string, fn: (c: import("pg").PoolClient) => Promise<T>): Promise<T> {
    const c = await db.admin.connect();
    try {
      await c.query("BEGIN");
      for (const sql of setup) await c.query(sql);
      await c.query("SELECT set_config('eureka.user_id', $1, true)", [actor]);
      await c.query("SET LOCAL ROLE eureka_app");
      return await fn(c);
    } finally {
      await c.query("ROLLBACK");
      c.release();
    }
  }
  const mixedRole = [
    `INSERT INTO eureka.role (key, label) VALUES ('c_db_mixed', 'DB Mixed')`,
    `INSERT INTO eureka.role_permission (role_key, permission, scope) VALUES ('c_db_mixed', 'access:manage', 'org'), ('c_db_mixed', 'candidate:read', 'team')`,
  ];

  it("permission flags are seeded from the catalog; built-in roles report no violation", async () => {
    const { rows } = await db.admin.query<{ key: string; is_admin_only: boolean; is_admin_compatible: boolean }>(
      `SELECT key, is_admin_only, is_admin_compatible FROM eureka.permission`);
    expect(rows.filter((r) => r.is_admin_only).map((r) => r.key).sort()).toEqual([...ADMIN_PERMISSIONS].sort());
    expect(rows.filter((r) => r.is_admin_compatible).map((r) => r.key).sort()).toEqual([...ADMIN_COMPATIBLE_PERMISSIONS].sort());
    expect((await asUser(db.app, U.admin, (c) => c.query(`SELECT * FROM authz.role_admin_violations()`))).rows).toEqual([]);
  });

  it("the violations report needs an admin; its helper is internal", async () => {
    for (const actor of [U.r1a, U.ceo, U.hr, NIL]) {
      await expect(asUser(db.app, actor, (c) => c.query(`SELECT * FROM authz.role_admin_violations()`)), actor).rejects.toThrow(/not_permitted/);
    }
    await expect(db.app.query(`SELECT * FROM authz.role_admin_violations()`)).rejects.toThrow(/not_permitted/);
    await expect(asUser(db.app, U.admin, (c) => c.query(`SELECT * FROM authz.role_admin_conflicts()`))).rejects.toThrow(/permission denied/);
  });

  it("admin_guard needs the admin trait as well as access:manage", async () => {
    const setup = [...mixedRole, `INSERT INTO eureka.user_role (user_id, role_key) VALUES ('${U.hr}', 'c_db_mixed')`];
    await withSetup(setup, U.hr, async (c) => {
      expect((await c.query(`SELECT authz.has_org('access:manage') AS ok`)).rows[0].ok).toBe(true);
      for (const sql of [
        `SELECT authz.admin_create_user('mixed@eureka.example', 'Mixed', NULL, NULL)`,
        `SELECT * FROM authz.role_admin_violations()`,
        `SELECT authz.role_create('Mixed Copy', 'lead', NULL, NULL, NULL, NULL)`,
      ]) {
        await c.query("SAVEPOINT s");
        await expect(c.query(sql)).rejects.toThrow(/not_permitted/);
        await c.query("ROLLBACK TO SAVEPOINT s");
      }
    });
  });

  it("an existing violation is reported, its edits still work, new violations are refused", async () => {
    await withSetup(mixedRole, U.admin, async (c) => {
      expect((await c.query(`SELECT role_key, permissions FROM authz.role_admin_violations()`)).rows)
        .toEqual([{ role_key: "c_db_mixed", permissions: ["access:manage"] }]);
      const set = async (grants: unknown, version: number | null = null) => {
        await c.query("SAVEPOINT s");
        try {
          return (await c.query(`SELECT authz.role_set_grants('c_db_mixed', $1::jsonb, $2) AS d`, [JSON.stringify(grants), version])).rows[0].d;
        } catch (err) {
          await c.query("ROLLBACK TO SAVEPOINT s");
          throw err;
        }
      };
      expect(await set({ "access:manage": "org", "candidate:read": "org" })).toEqual({ added: [], removed: [], changed: ["candidate:read"] });
      await expect(set({ "access:manage": "org", "candidate:read": "org", "audit:read": "org" })).rejects.toThrow(/admin_permission_needs_admin_role/);
      // NULL grants are refused, not read as "remove everything" (rule 1).
      await expect(set(null)).rejects.toThrow(/invalid_grants/);
      // Version check: 2 after the one change; a stale expected version is refused.
      await expect(set({ "access:manage": "org" }, 1)).rejects.toThrow(/stale/);
      expect(await set({ "access:manage": "org" }, 2)).toEqual({ added: [], removed: ["candidate:read"], changed: [] });
      expect((await c.query(`SELECT row_version FROM eureka.role WHERE key = 'c_db_mixed'`)).rows[0].row_version).toBe(3);
      await c.query("SAVEPOINT u");
      await expect(c.query(`SELECT authz.role_update('c_db_mixed', '{"label":"X"}'::jsonb, 2)`)).rejects.toThrow(/stale/);
      await c.query("ROLLBACK TO SAVEPOINT u");
      expect((await c.query(`SELECT authz.role_update('c_db_mixed', '{"label":"DB Mixed II"}'::jsonb, 3) AS ch`)).rows[0].ch).toEqual(["label"]);
    });
  });

  it("row_version is server-managed: the API role cannot write it", async () => {
    await expect(asUser(db.app, U.admin, (c) => c.query(`UPDATE eureka.role SET row_version = 9 WHERE key = 'lead'`))).rejects.toThrow(/permission denied/);
  });
});

describe("admin is only admin, per user (migration 0510)", () => {
  const Z = "00000000-0000-0000-0000-00000000a480";
  type C = import("pg").PoolClient;
  /** Runs fn as eureka_app after setup as the owner, all rolled back; `as` switches the acting user. */
  async function inTx<R>(setup: string[], fn: (c: C, as: (u: string) => Promise<unknown>) => Promise<R>): Promise<R> {
    const c = await db.admin.connect();
    try {
      await c.query("BEGIN");
      await c.query(`INSERT INTO eureka.app_user (id, email, display_name) VALUES ('${Z}', 'z480@eureka.example', 'Zed')`);
      for (const sql of setup) await c.query(sql);
      await c.query("SET LOCAL ROLE eureka_app");
      const as = (u: string) => c.query("SELECT set_config('eureka.user_id', $1, true)", [u]);
      await as(U.admin);
      return await fn(c, as);
    } finally {
      await c.query("ROLLBACK");
      c.release();
    }
  }
  /** One statement under a savepoint: the first row, or a rejection (rolled back to the savepoint). */
  async function attempt(c: C, sql: string, params: unknown[] = []) {
    await c.query("SAVEPOINT a");
    try {
      const r = (await c.query(sql, params)).rows[0];
      await c.query("RELEASE SAVEPOINT a");
      return r;
    } catch (err) {
      await c.query("ROLLBACK TO SAVEPOINT a");
      throw err;
    }
  }
  const grant = (c: C, user: string, role: string) => attempt(c, `SELECT * FROM authz.request_role($1, $2, NULL)`, [user, role]);
  const chatOnly = [
    `INSERT INTO eureka.role (key, label) VALUES ('c_db_chat', 'DB Chat')`,
    `INSERT INTO eureka.role_permission (role_key, permission, scope) VALUES ('c_db_chat', 'chat:use', 'own')`,
    `INSERT INTO eureka.role (key, label) VALUES ('c_db_empty', 'DB Empty')`,
  ];

  it("classifies roles: admin trait, data, admin-compatible only", async () => {
    await inTx([...chatOnly,
      `INSERT INTO eureka.role (key, label) VALUES ('c_db_mixed', 'DB Mixed')`,
      `INSERT INTO eureka.role_permission (role_key, permission, scope) VALUES ('c_db_mixed', 'access:manage', 'org')`,
    ], async (c) => {
      const cls = Object.fromEntries((await c.query<{ role_key: string; classification: string }>(
        `SELECT role_key, classification FROM authz.role_classes()`)).rows.map((r) => [r.role_key, r.classification]));
      expect(cls).toMatchObject({
        org_admin: "admin", recruiter: "data", hr: "data",
        c_db_chat: "admin_compatible_only", c_db_empty: "admin_compatible_only",
        // An admin-only permission without the admin trait is not admin-compatible: a data role.
        c_db_mixed: "data",
      });
    });
  });

  it("refuses mixing in both directions; admin-compatible roles go with either", async () => {
    await inTx(chatOnly, async (c) => {
      await expect(grant(c, U.admin2, "recruiter")).rejects.toThrow(/separation_of_duties/);
      await expect(grant(c, U.l1, "org_admin")).rejects.toThrow(/separation_of_duties/);
      expect(await grant(c, U.admin2, "c_db_chat")).toMatchObject({ request_status: "applied" });
      expect(await grant(c, U.admin2, "c_db_empty")).toMatchObject({ request_status: "applied" });
      expect(await grant(c, U.r1a, "c_db_chat")).toMatchObject({ request_status: "applied" });
      // A compatible role does not open the door: the data role still blocks admin.
      await expect(grant(c, U.r1a, "org_admin")).rejects.toThrow(/separation_of_duties/);
      // A user holding only compatible roles may become an admin (restricted: pending here).
      expect(await grant(c, Z, "c_db_chat")).toMatchObject({ request_status: "applied" });
      expect(await grant(c, Z, "org_admin")).toMatchObject({ request_status: "pending_approval" });
      expect((await c.query(`SELECT * FROM authz.user_admin_violations()`)).rows).toEqual([]);
    });
  });

  it("refuses granting a role that itself breaks admin/data separation", async () => {
    await inTx([
      `INSERT INTO eureka.role (key, label) VALUES ('c_db_mixed', 'DB Mixed')`,
      `INSERT INTO eureka.role_permission (role_key, permission, scope) VALUES ('c_db_mixed', 'access:manage', 'org'), ('c_db_mixed', 'candidate:read', 'team')`,
      `INSERT INTO eureka.role (key, label, is_admin) VALUES ('c_db_busy_admin', 'DB Busy Admin', true)`,
      `INSERT INTO eureka.role_permission (role_key, permission, scope) VALUES ('c_db_busy_admin', 'access:manage', 'org'), ('c_db_busy_admin', 'candidate:read', 'org')`,
    ], async (c) => {
      await expect(grant(c, Z, "c_db_mixed")).rejects.toThrow(/role_violates_admin_separation/);
      await expect(grant(c, U.r1a, "c_db_mixed")).rejects.toThrow(/role_violates_admin_separation/);
      await expect(grant(c, U.admin2, "c_db_busy_admin")).rejects.toThrow(/role_violates_admin_separation/);
      await expect(grant(c, Z, "c_db_busy_admin")).rejects.toThrow(/role_violates_admin_separation/);
    });
  });

  it("approval re-checks: a pending restricted role is refused once the user mixes", async () => {
    await inTx([], async (c, as) => {
      const ceo = await grant(c, Z, "ceo");
      const adm = await grant(c, Z, "org_admin");
      expect([ceo.request_status, adm.request_status]).toEqual(["pending_approval", "pending_approval"]);
      await as(U.admin2);
      expect(await attempt(c, `SELECT authz.approve_role_request($1) AS s`, [adm.request_id])).toEqual({ s: "approved" });
      await expect(attempt(c, `SELECT authz.approve_role_request($1) AS s`, [ceo.request_id])).rejects.toThrow(/separation_of_duties/);
    });
  });

  it("approval refuses a role that came to break the rule after the request", async () => {
    await inTx([
      `INSERT INTO eureka.role (key, label) VALUES ('c_db_later', 'DB Later')`,
      // candidate:delete at org is org-wide sensitive: the role is restricted, so the grant waits.
      `INSERT INTO eureka.role_permission (role_key, permission, scope) VALUES ('c_db_later', 'candidate:delete', 'org')`,
    ], async (c, as) => {
      const q = await grant(c, Z, "c_db_later");
      expect(q.request_status).toBe("pending_approval");
      await c.query("RESET ROLE");
      await c.query(`INSERT INTO eureka.role_permission (role_key, permission, scope) VALUES ('c_db_later', 'audit:read', 'org')`);
      await c.query("SET LOCAL ROLE eureka_app");
      await as(U.admin2);
      await expect(attempt(c, `SELECT authz.approve_role_request($1) AS s`, [q.request_id])).rejects.toThrow(/role_violates_admin_separation/);
    });
  });

  it("a custom role an admin holds takes no business permission", async () => {
    await inTx(chatOnly, async (c) => {
      await grant(c, U.admin2, "c_db_chat");
      const set = (key: string, grants: unknown) =>
        attempt(c, `SELECT authz.role_set_grants($1, $2::jsonb, NULL) AS d`, [key, JSON.stringify(grants)]);
      await expect(set("c_db_chat", { "chat:use": "own", "candidate:read": "own" })).rejects.toThrow(/role_held_by_admin/);
      await expect(set("c_db_chat", { "candidate:read": "own" })).rejects.toThrow(/role_held_by_admin/);
      // Admin-compatible additions are fine.
      expect(await set("c_db_chat", { "chat:use": "own", "staff.contact:read": "org" })).toMatchObject({ d: { added: ["staff.contact:read"] } });
      // A role held only by non-admins may become a data role.
      await grant(c, U.r1a, "c_db_empty");
      expect(await set("c_db_empty", { "candidate:read": "own" })).toMatchObject({ d: { added: ["candidate:read"] } });
    });
  });

  it("existing mixed users are reported (not stripped) to admins only; the helper is internal", async () => {
    await inTx([`INSERT INTO eureka.user_role (user_id, role_key) VALUES ('${U.admin2}', 'recruiter')`], async (c, as) => {
      expect((await c.query(`SELECT * FROM authz.user_admin_violations()`)).rows).toEqual([
        { user_id: U.admin2, display_name: "admin2", status: "active", admin_roles: ["org_admin"], data_roles: ["recruiter"] },
      ]);
      for (const actor of [U.r1a, U.ceo, U.hr, NIL]) {
        await as(actor);
        await expect(attempt(c, `SELECT * FROM authz.user_admin_violations()`), actor).rejects.toThrow(/not_permitted/);
      }
      await as(U.admin);
      await expect(attempt(c, `SELECT * FROM authz.user_admin_conflicts()`)).rejects.toThrow(/permission denied/);
    });
    // Built-in fixture users comply.
    expect((await asUser(db.app, U.admin, (c) => c.query(`SELECT * FROM authz.user_admin_violations()`))).rows).toEqual([]);
  });

  it("single-admin mode still applies an admin role to a clean user, and still separates", async () => {
    await inTx([`INSERT INTO authz.policy_setting (key, value) VALUES ('single_admin_mode', 'on')
                 ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`], async (c) => {
      expect(await grant(c, Z, "org_admin")).toMatchObject({ request_status: "applied" });
      await expect(grant(c, Z, "recruiter")).rejects.toThrow(/separation_of_duties/);
      await expect(grant(c, U.r1a, "org_admin")).rejects.toThrow(/separation_of_duties/);
    });
  });
});

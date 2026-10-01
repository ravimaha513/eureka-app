import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { candidateVisible, hotlistVisible, ownsCandidate, resolveScope } from "@eureka/shared";
import { asUser, createTestDb, type TestDb } from "./db-harness.js";
import { T, U, seedFixtures, toUserAccess, type FixtureCandidate } from "./fixtures.js";

/** Migration 0025: saved views (RLS, guards) and authz.hotlist_export, tested in the database alone. */
let db: TestDb;
let candidates: FixtureCandidate[];
const users = Object.keys(U) as (keyof typeof U)[];

beforeAll(async () => {
  db = await createTestDb();
  candidates = await seedFixtures(db.admin);
  // Two views per user, committed, so every user's rows exist while the others read.
  for (const key of users) {
    await asUser(db.app, U[key], async (c) => {
      await c.query(`INSERT INTO eureka.hotlist_view (name, filters) VALUES ($1, '{"status":"active"}'), ($2, '{}')`,
        [`${key} active`, `${key} all`]);
    }, true);
  }
  // A rating on every candidate, so the export's rating rule is observable.
  // (Seeded as superuser with triggers off: the column guard needs a rater's grant.)
  const c = await db.admin.connect();
  try {
    await c.query("BEGIN");
    await c.query("SET LOCAL session_replication_role = replica");
    await c.query(`UPDATE eureka.candidate SET technical_rating = 4`);
    await c.query("COMMIT");
  } finally {
    c.release();
  }
}, 90_000);

afterAll(async () => {
  await db?.drop();
});

describe("saved views: RLS keeps each user's views private (differential)", () => {
  it("the table has RLS enabled and forced", async () => {
    const { rows } = await db.admin.query(`SELECT relrowsecurity r, relforcerowsecurity f FROM pg_class WHERE oid = 'eureka.hotlist_view'::regclass`);
    expect(rows[0]).toEqual({ r: true, f: true });
  });

  it.each(users)("%s reads exactly their own views", async (key) => {
    const all = (await db.admin.query<{ id: string; owner_id: string }>(`SELECT id, owner_id FROM eureka.hotlist_view`)).rows;
    const expected = all.filter((v) => v.owner_id === U[key]).map((v) => v.id).sort();
    const actual = await asUser(db.app, U[key], async (c) =>
      (await c.query<{ id: string }>(`SELECT id FROM eureka.hotlist_view`)).rows.map((r) => r.id).sort());
    expect(expected).toHaveLength(2);
    expect(actual).toEqual(expected);
  });

  it("no user context sees nothing and cannot insert", async () => {
    expect((await db.app.query(`SELECT count(*)::int n FROM eureka.hotlist_view`)).rows[0].n).toBe(0);
    await expect(db.app.query(`INSERT INTO eureka.hotlist_view (name) VALUES ('x')`)).rejects.toThrow(/server_managed_field|row-level security|null value/);
  });

  it("another user's view cannot be renamed, changed or deleted (0 rows), even by an org admin", async () => {
    const victim = (await db.admin.query<{ id: string }>(`SELECT id FROM eureka.hotlist_view WHERE owner_id = $1 LIMIT 1`, [U.r1a])).rows[0]!.id;
    for (const key of ["r1b", "l1", "ceo", "admin"] as const) {
      const n = await asUser(db.app, U[key], async (c) => {
        const a = (await c.query(`UPDATE eureka.hotlist_view SET name = 'stolen' WHERE id = $1`, [victim])).rowCount;
        const b = (await c.query(`DELETE FROM eureka.hotlist_view WHERE id = $1`, [victim])).rowCount;
        return (a ?? 0) + (b ?? 0);
      });
      expect(n, key).toBe(0);
    }
    expect((await db.admin.query(`SELECT name FROM eureka.hotlist_view WHERE id = $1`, [victim])).rows[0].name).toBe("r1a active");
  });

  it("owner, id and timestamps are server-managed (column grants and guard triggers)", async () => {
    await expect(asUser(db.app, U.r1a, (c) => c.query(`INSERT INTO eureka.hotlist_view (owner_id, name) VALUES ($1, 'x')`, [U.r1b])))
      .rejects.toThrow(/permission denied/);
    await expect(asUser(db.app, U.r1a, (c) => c.query(`INSERT INTO eureka.hotlist_view (name, created_at) VALUES ('x', '2000-01-01')`)))
      .rejects.toThrow(/permission denied/);
    await expect(asUser(db.app, U.r1a, (c) => c.query(`UPDATE eureka.hotlist_view SET owner_id = $1`, [U.r1b])))
      .rejects.toThrow(/permission denied/);
    await expect(asUser(db.app, U.r1a, (c) => c.query(`UPDATE eureka.hotlist_view SET updated_at = now()`)))
      .rejects.toThrow(/permission denied/);
    // The guard holds even for a role with full table rights (the owner role, outside RLS).
    await expect(db.admin.query(`INSERT INTO eureka.hotlist_view (owner_id, name) VALUES ($1, 'x')`, [U.r1a]))
      .rejects.toThrow(/server_managed_field/);
    const id = (await db.admin.query<{ id: string }>(`SELECT id FROM eureka.hotlist_view WHERE owner_id = $1 LIMIT 1`, [U.r1a])).rows[0]!.id;
    await expect(db.admin.query(`UPDATE eureka.hotlist_view SET owner_id = $2 WHERE id = $1`, [id, U.r1b])).rejects.toThrow(/server_managed_field/);
  });

  it("a view is stamped by the server and its name is unique per owner (case-insensitive)", async () => {
    await asUser(db.app, U.r2a, async (c) => {
      const r = (await c.query(`INSERT INTO eureka.hotlist_view (name) VALUES ('Mine') RETURNING owner_id, created_at, updated_at`)).rows[0];
      expect(r.owner_id).toBe(U.r2a);
      await expect(c.query(`INSERT INTO eureka.hotlist_view (name) VALUES ('MINE')`)).rejects.toThrow(/hotlist_view_owner_name/);
    });
    // Another user may use the same name.
    await asUser(db.app, U.r3a, (c) => c.query(`INSERT INTO eureka.hotlist_view (name) VALUES ('r2a all')`));
  });

  it("filters must be a small JSON object; names are trimmed and bounded", async () => {
    await expect(asUser(db.app, U.r1a, (c) => c.query(`INSERT INTO eureka.hotlist_view (name, filters) VALUES ('a', '[]')`))).rejects.toThrow(/check constraint/);
    await expect(asUser(db.app, U.r1a, (c) => c.query(`INSERT INTO eureka.hotlist_view (name, filters) VALUES ('a', $1)`,
      [JSON.stringify({ search: "x".repeat(5000) })]))).rejects.toThrow(/check constraint/);
    await expect(asUser(db.app, U.r1a, (c) => c.query(`INSERT INTO eureka.hotlist_view (name) VALUES (' padded ')`))).rejects.toThrow(/check constraint/);
    await expect(asUser(db.app, U.r1a, (c) => c.query(`INSERT INTO eureka.hotlist_view (name) VALUES ('')`))).rejects.toThrow(/check constraint/);
  });

  it("a user keeps at most 50 views", async () => {
    await asUser(db.app, U.coach, async (c) => {
      for (let i = 0; i < 48; i++) await c.query(`INSERT INTO eureka.hotlist_view (name) VALUES ($1)`, [`v${i}`]);
      await expect(c.query(`INSERT INTO eureka.hotlist_view (name) VALUES ('one too many')`)).rejects.toThrow(/too_many_views/);
    });
  });
});

describe("authz.hotlist_export (differential against the engine)", () => {
  type Row = { id: string; phone: string | null; technical_rating: number | null };
  const exportAs = (userId: string, limit = 60_000, args: (string | null)[] = [null, null, null, null]) =>
    asUser(db.app, userId, async (c) =>
      (await c.query<Row>(`SELECT * FROM authz.hotlist_export($1, $2, $3, $4, $5)`, [...args, limit])).rows);

  const setPolicy = (v: "everyone" | "team") =>
    db.admin.query(`UPDATE authz.policy_setting SET value = $1 WHERE key = 'hotlist_visibility'`, [v]);

  // 0030: a row must be in the report:export scope AND on the caller's Hot List.
  describe.each(["everyone", "team"] as const)("Hot List policy %s", (policy) => {
    beforeAll(() => setPolicy(policy));
    afterAll(() => setPolicy("everyone"));

    it.each(users)("%s exports exactly the Hot List candidates in their report:export scope", async (key) => {
      const access = toUserAccess(key);
      const scope = resolveScope(access, "report:export");
      const hot = resolveScope(access, "hotlist:read", policy);
      const expected = scope
        ? candidates.filter((c) => ownsCandidate(scope, c) && hotlistVisible(hot, c)).map((c) => c.id).sort()
        : [];
      const rows = await exportAs(U[key]);
      expect(rows.map((r) => r.id).sort()).toEqual(expected);
      const readScope = resolveScope(access, "candidate:read");
      for (const r of rows) {
        // Phones are always masked in exports (design B4.6), even for the owning team.
        expect(r.phone).toMatch(/^•••-•••-\d\d$/);
        const cand = candidates.find((c) => c.id === r.id)!;
        expect(r.technical_rating).toBe(candidateVisible(readScope, cand) ? 4 : null);
      }
    });
  });

  it("under the team policy, a row outside the hotlist:read scope is not exported even inside report:export", async () => {
    await setPolicy("team");
    // Simulates catalog drift: the lead keeps report:export at team scope but holds
    // hotlist:read only at own scope (rolled back). Holding the permission is not enough.
    const c = await db.admin.connect();
    try {
      await c.query("BEGIN");
      await c.query(`UPDATE eureka.role_permission SET scope = 'own' WHERE role_key = 'lead' AND permission = 'hotlist:read'`);
      await c.query("SELECT set_config('eureka.user_id', $1, true)", [U.l1]);
      await c.query("SET LOCAL ROLE eureka_app");
      const rows = (await c.query<{ id: string; visibility: string; marketing_status: string }>(
        `SELECT id, visibility, marketing_status FROM authz.hotlist_export(NULL, NULL, NULL, NULL, 60000)`)).rows;
      // Only Open-to-all-teams marketable candidates remain on that Hot List (AS-07).
      const expected = candidates.filter((x) => x.teamId === T.t1 && x.visibility === "all_teams"
        && ["active", "full_of_interviews"].includes(x.marketingStatus)).map((x) => x.id).sort();
      expect(rows.map((r) => r.id).sort()).toEqual(expected);
      expect(expected.length).toBeLessThan(candidates.filter((x) => x.teamId === T.t1).length);
    } finally {
      await c.query("ROLLBACK");
      c.release();
      await setPolicy("everyone");
    }
    expect((await exportAs(U.l1)).length).toBeGreaterThan(0);
  });

  it("never returns DOB, email or a raw phone column", async () => {
    const { rows } = await db.admin.query<{ cols: string[] }>(`
      SELECT proargnames AS cols FROM pg_proc WHERE oid = 'authz.hotlist_export(text,text,text,text,int)'::regprocedure`);
    const cols = rows[0]!.cols.join(",");
    expect(cols).not.toMatch(/dob|email|phone_e164/);
  });

  it("applies the filters and the cap (at most 50,001 rows, so truncation is detectable)", async () => {
    const all = await exportAs(U.ceo);
    expect(all.length).toBeGreaterThan(10);
    expect(await exportAs(U.ceo, 3)).toHaveLength(3);
    const onHold = await exportAs(U.ceo, 60_000, ["on_hold", null, null, null]);
    expect(onHold.length).toBe(candidates.filter((c) => c.marketingStatus === "on_hold").length);
    const named = await exportAs(U.ceo, 60_000, [null, null, null, "%Cand1 %"]);
    expect(named).toHaveLength(1);
    const { rows } = await db.admin.query<{ src: string }>(`SELECT prosrc AS src FROM pg_proc WHERE proname = 'hotlist_export'`);
    expect(rows[0]!.src).toMatch(/50001/);
  });

  it("a deactivated user exports nothing", async () => {
    await db.admin.query(`UPDATE eureka.app_user SET status = 'inactive' WHERE id = $1`, [U.m2]);
    try {
      expect(await exportAs(U.m2)).toEqual([]);
    } finally {
      await db.admin.query(`UPDATE eureka.app_user SET status = 'active' WHERE id = $1`, [U.m2]);
    }
  });

  it("is executable only by the app role", async () => {
    const { rows } = await db.admin.query(`
      SELECT has_function_privilege('eureka_worker', 'authz.hotlist_export(text,text,text,text,int)', 'EXECUTE') w,
             has_function_privilege('eureka_app', 'authz.hotlist_export(text,text,text,text,int)', 'EXECUTE') a`);
    expect(rows[0]).toEqual({ w: false, a: true });
  });
});

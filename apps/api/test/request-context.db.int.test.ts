import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AccessService, accessFromFacts, type AccessFacts } from "../src/platform/access.service.js";
import { SessionService } from "../src/platform/session.service.js";
import { stepUpStatus } from "../src/platform/step-up.js";
import { asUser, createTestDb, type TestDb } from "./db-harness.js";
import { LOC, T, U, seedFixtures } from "./fixtures.js";
import { newCandidate } from "./placement-seed.js";

/**
 * authz.request_context (migration 0517, audit F-03): the AuthGuard's one-statement
 * session check + access load + temporary-password flag. The access facts must be
 * exactly what the reference loader (AccessService.load, the old per-request path)
 * returns, for every seeded user; the session rules must be the old CTE's.
 */
let db: TestDb;
const IDLE = 30;
const BCRYPT = `$2b$10$${"a".repeat(53)}`;

beforeAll(async () => {
  db = await createTestDb();
  await seedFixtures(db.admin);
  // Exercise every fact: a "Selected teams" share reaching Team Anjali, and a temporary password.
  const cand = await newCandidate(db, { teamId: T.t1, recruiterId: U.r1a, locationId: LOC.dallas });
  await asUser(db.app, U.l1, (c) => c.query("SELECT authz.set_candidate_visibility($1, 'selected_teams', $2::uuid[])", [cand.id, [T.t2]]), true);
  await db.admin.query(`INSERT INTO authz.user_credential (user_id, password_hash, must_change) VALUES ($1, $2, true), ($3, $2, false)`,
    [U.r2a, BCRYPT, U.r3a]);
}, 120_000);

afterAll(async () => {
  await db?.drop();
});

async function session(userId: string, opts: { seenAgo?: string; expiresIn?: string; revoked?: boolean } = {}): Promise<Buffer> {
  const hash = SessionService.hash(randomBytes(32).toString("base64url"));
  await db.admin.query(
    `INSERT INTO eureka.session (id_hash, user_id, expires_at, auth_time, access_version, last_seen_at, revoked_at)
     VALUES ($1, $2, now() + $3::interval, now() - interval '2 hours', 0, now() - $4::interval, CASE WHEN $5 THEN now() END)`,
    [hash, userId, opts.expiresIn ?? "8 hours", opts.seenAgo ?? "0 seconds", opts.revoked ?? false]);
  return hash;
}

type Ctx = { user_id: string; auth_time: Date; access: AccessFacts; must_change: boolean };
const context = async (hash: Buffer | null, checkPassword = true, idle: number | null = IDLE) =>
  (await db.app.query<Ctx>(`SELECT * FROM authz.request_context($1, $2, $3)`, [hash, idle, checkPassword])).rows;

describe("authz.request_context: access facts (differential)", () => {
  it("returns exactly AccessService.load's facts and the old must_change for every seeded user", async () => {
    const users = (await db.admin.query<{ id: string }>(`SELECT id FROM eureka.app_user WHERE status = 'active' ORDER BY id`)).rows.map((r) => r.id);
    expect(users.length).toBeGreaterThanOrEqual(Object.keys(U).length);
    const loader = new AccessService();
    let sawShared = false;
    for (const id of users) {
      const old = await asUser(db.app, id, async (c) => ({
        access: await loader.load(c, id),
        mustChange: (await c.query<{ m: boolean }>(`SELECT authz.password_must_change() AS m`)).rows[0]!.m,
      }));
      const [row] = await context(await session(id));
      expect(row, id).toBeDefined();
      expect(row!.user_id).toBe(id);
      expect(accessFromFacts(row!.user_id, row!.access), id).toStrictEqual(old.access);
      expect(row!.must_change, id).toBe(old.mustChange);
      sawShared ||= (old.access.sharedCandidateIds ?? []).length > 0;
    }
    expect(sawShared).toBe(true);
  });

  it("must_change is read only when asked (PASSWORD_LOGIN=on)", async () => {
    const h = await session(U.r2a);
    expect((await context(h, true))[0]!.must_change).toBe(true);
    expect((await context(h, false))[0]!.must_change).toBe(false);
    expect((await context(await session(U.r3a), true))[0]!.must_change).toBe(false);
  });

  it("a revoked role takes effect on the very next call (no cache)", async () => {
    const h = await session(U.hr);
    const before = (await context(h))[0]!.access.roles.map((r) => r.role_key);
    expect(before).toContain("hr");
    await db.admin.query(`UPDATE eureka.user_role SET valid = tstzrange(lower(valid), now()) WHERE user_id = $1 AND role_key = 'hr'`, [U.hr]);
    expect((await context(h))[0]!.access.roles.map((r) => r.role_key)).not.toContain("hr");
  });

  it("leaves eureka.user_id as it found it", async () => {
    const c = await db.app.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT set_config('eureka.user_id', $1, true)", [U.ceo]);
      const [row] = (await c.query<Ctx>(`SELECT * FROM authz.request_context($1, $2, true)`, [await session(U.r1a), IDLE])).rows;
      expect(row!.user_id).toBe(U.r1a);
      expect((await c.query<{ u: string }>(`SELECT authz.current_user_id()::text AS u`)).rows[0]!.u).toBe(U.ceo);
      await c.query("ROLLBACK");
      expect((await c.query<{ u: string | null }>(`SELECT authz.current_user_id()::text AS u`)).rows[0]!.u).toBeNull();
    } finally { c.release(); }
  });
});

describe("authz.request_context: session rules (same as the old resolve CTE)", () => {
  it("no row for an unknown, revoked, expired or idle session, or a NULL input", async () => {
    expect(await context(SessionService.hash("nope"))).toEqual([]);
    expect(await context(await session(U.r1a, { revoked: true }))).toEqual([]);
    expect(await context(await session(U.r1a, { expiresIn: "-1 second" }))).toEqual([]);
    expect(await context(await session(U.r1a, { seenAgo: `${IDLE + 1} minutes` }))).toEqual([]);
    expect(await context(null)).toEqual([]);
    expect(await context(await session(U.r1a), true, null)).toEqual([]);
  });

  it("no row for a user who is no longer active", async () => {
    const h = await session(U.imm);
    expect(await context(h)).toHaveLength(1);
    await db.admin.query(`UPDATE eureka.app_user SET status = 'inactive' WHERE id = $1`, [U.imm]);
    expect(await context(h)).toEqual([]);
  });

  it("returns auth_time and touches last_seen_at at most once a minute", async () => {
    const seen = async (h: Buffer) => (await db.admin.query<{ s: Date; a: Date }>(
      `SELECT last_seen_at AS s, auth_time AS a FROM eureka.session WHERE id_hash = $1`, [h])).rows[0]!;
    const fresh = await session(U.r1b, { seenAgo: "10 seconds" });
    const f0 = await seen(fresh);
    const [row] = await context(fresh);
    expect(row!.auth_time.getTime()).toBe(f0.a.getTime());
    expect((await seen(fresh)).s.getTime()).toBe(f0.s.getTime());
    const stale = await session(U.r1b, { seenAgo: "5 minutes" });
    const s0 = await seen(stale);
    await context(stale);
    expect((await seen(stale)).s.getTime()).toBeGreaterThan(s0.s.getTime() + 4 * 60_000);
  });

  it("eureka_app may call it; nobody else", async () => {
    const acl = (await db.admin.query<{ acl: string }>(
      `SELECT proacl::text AS acl FROM pg_proc WHERE oid = 'authz.request_context(bytea, integer, boolean)'::regprocedure`)).rows[0]!.acl;
    expect(acl).toContain("eureka_app=X/");
    expect(acl).not.toMatch(/(^|[{,])=X/);
    await expect(db.worker.query(`SELECT * FROM authz.request_context($1, 30, true)`, [SessionService.hash("x")]))
      .rejects.toMatchObject({ code: "42501" });
  });
});

describe("stepUpStatus (GET /api/auth/step-up in one statement)", () => {
  it("matches step_up_current and password_has_credential", async () => {
    const h = await session(U.r3a);
    const st = (user: string, on: boolean) => asUser(db.app, user, (c) => stepUpStatus(c, { sessionHash: h }, on));
    expect(await st(U.r3a, true)).toEqual({ grant: undefined, hasPassword: true });
    expect(await st(U.r3a, false)).toEqual({ grant: undefined, hasPassword: false });
    expect(await st(U.l3, true)).toEqual({ grant: undefined, hasPassword: false });
    await db.admin.query(`INSERT INTO authz.policy_setting (key, value) VALUES ('dev_step_up', 'on') ON CONFLICT (key) DO UPDATE SET value = 'on'`);
    await asUser(db.app, U.r3a, (c) => c.query(`SELECT * FROM authz.step_up_dev($1, 10)`, [h]), true);
    const g = await st(U.r3a, true);
    expect(g.grant?.method).toBe("dev");
    expect(g.grant?.expires_at).toBeInstanceOf(Date);
  });
});

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asUser, createTestDb, type TestDb } from "./db-harness.js";
import { LOC, T, U, seedFixtures } from "./fixtures.js";
import { createPlacement, newCandidate, selectedSubmission } from "./placement-seed.js";

/**
 * Scope follows reporting lines, not upward team membership (migration 0210).
 * Orgs put a manager's leads in the manager's team and the manager in the AD's
 * team; none of that may widen anyone's scope upward or sideways.
 */
let db: TestDb;
const TM1 = randomUUID(); // led by m1; leads l1 and l2 are members
const TAD = randomUUID(); // led by ad; manager m1 and lead l3 (under m2) are members

beforeAll(async () => {
  db = await createTestDb();
  await seedFixtures(db.admin);
  await db.admin.query(`INSERT INTO eureka.team (id, name, lead_id) VALUES ($1,'M1 team',$2), ($3,'AD team',$4)`,
    [TM1, U.m1, TAD, U.ad]);
  await db.admin.query(`INSERT INTO eureka.team_member (team_id, user_id) VALUES ($1,$2), ($1,$3), ($4,$5), ($4,$6)`,
    [TM1, U.l1, U.l2, TAD, U.m1, U.l3]);
}, 120_000);

afterAll(async () => {
  await db?.drop();
});

const err = (p: Promise<unknown>) => p.then(() => "ok", (e: Error & { code?: string }) => `${e.code}:${e.message}`);
const sorted = (xs: string[]) => [...xs].sort();
const arr = (user: string, sql: string, params: unknown[] = []) => asUser(db.app, user, async (c) =>
  sorted((await c.query<{ ids: string[] }>(sql, params)).rows[0]!.ids));

describe("authz.team_ids (0210)", () => {
  it("a lead's team scope is the team they lead, not their manager's team", async () => {
    expect(await arr(U.l1, "SELECT authz.team_ids('candidate:read') AS ids")).toEqual([T.t1]);
  });

  it("a manager's hierarchy is led teams plus teams led below, not the AD's team", async () => {
    const ids = await arr(U.m1, "SELECT authz.team_ids('candidate:read') AS ids");
    expect(ids).toContain(TM1);
    expect(ids).not.toContain(TAD);
    expect(ids).toEqual(expect.arrayContaining([T.t1, T.t2]));
  });

  it("the AD still covers the manager's team through reporting lines", async () => {
    expect(await arr(U.ad, "SELECT authz.team_ids('candidate:read') AS ids")).toEqual(expect.arrayContaining([TAD, TM1]));
  });

  it("a recruiter keeps the team they are a member of", async () => {
    expect(await arr(U.r1a, "SELECT authz.team_ids('job:read') AS ids")).toEqual([T.t1]);
  });
});

describe("authz.actor_team (0210)", () => {
  it("prefers the team one leads over a membership", async () => {
    const team = await asUser(db.app, U.l1, async (c) =>
      (await c.query<{ t: string }>("SELECT authz.actor_team() AS t")).rows[0]!.t);
    expect(team).toBe(T.t1);
  });
});

describe("authz.scope_user_ids (0210)", () => {
  it("a lead never covers their manager or peer leads", async () => {
    expect(await arr(U.l1, "SELECT authz.scope_user_ids('performance:read') AS ids"))
      .toEqual(sorted([U.l1, U.r1a, U.r1b]));
  });

  it("a manager never covers their AD", async () => {
    for (const perm of ["performance:read", "performance.target:manage", "designation:change"]) {
      expect(await arr(U.m1, "SELECT authz.scope_user_ids($1) AS ids", [perm])).not.toContain(U.ad);
    }
  });
});

describe("authz.move_team_member (0210 via team_ids)", () => {
  it("a manager cannot move people out of the AD's team they are a member of", async () => {
    expect(await err(asUser(db.app, U.m1, (c) =>
      c.query("SELECT * FROM authz.move_team_member($1,$2,$3,NULL)", [U.l3, TAD, TM1]), true)))
      .toMatch(/not_in_scope/);
  });
});

describe("0211 back-fill: rows a lead stamped with a team they don't lead", () => {
  const team = async (table: string, id: string) =>
    (await db.admin.query<{ team_id: string }>(`SELECT team_id FROM eureka.${table} WHERE id = $1`, [id])).rows[0]!.team_id;

  it("moves the lead's rows and their snapshots to the lead's own team, and nothing else", async () => {
    // As 0210's predecessor did: l1's candidate, submission and placement carry the manager's team.
    const cand = await newCandidate(db, { teamId: TM1, recruiterId: U.l1, locationId: LOC.dallas });
    const sub = await selectedSubmission(db, U.l1, cand.id);
    // An open submission (a selected one is closed to new interviews) with an interview.
    const open = await selectedSubmission(db, U.l1, cand.id, "under_review");
    const iv = await asUser(db.app, U.l1, async (c) => (await c.query<{ id: string }>(
      `INSERT INTO eureka.interview (submission_id, round, starts_at, ends_at)
       VALUES ($1,'L1',now() - interval '2 days',now() - interval '2 days' + interval '1 hour') RETURNING id`, [open])).rows[0]!.id, true);
    await db.admin.query(`BEGIN; SET LOCAL session_replication_role = replica;
      UPDATE eureka.submission SET team_id = '${TM1}' WHERE id IN ('${sub}', '${open}');
      UPDATE eureka.interview SET team_id = '${TM1}' WHERE id = '${iv}'; COMMIT;`);
    const pl = await createPlacement(db, U.l1, sub);
    await asUser(db.app, U.hr, (c) => c.query(`SELECT * FROM authz.update_bgc($1, '{"status":"initiated"}'::jsonb, NULL)`, [pl.id]), true);
    const other = await newCandidate(db, { teamId: T.t1, recruiterId: U.r1a, locationId: LOC.dallas });
    expect(await team("placement", pl.id)).toBe(TM1);
    expect((await db.admin.query("SELECT team_id FROM eureka.bgc WHERE placement_id = $1", [pl.id])).rows[0]!.team_id).toBe(TM1);

    const sql = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../../db/migrations/0211_lead_team_backfill.sql"), "utf8");
    const c = await db.admin.connect();
    try {
      await c.query("BEGIN");
      await c.query(sql);
      await c.query("COMMIT");
    } finally {
      c.release();
    }

    expect(await team("candidate", cand.id)).toBe(T.t1);
    expect(await team("submission", sub)).toBe(T.t1);
    expect(await team("interview", iv)).toBe(T.t1);
    expect(await team("placement", pl.id)).toBe(T.t1);
    const items = (await db.admin.query<{ team_id: string }>(
      "SELECT team_id FROM eureka.checklist_item WHERE placement_id = $1 UNION SELECT team_id FROM eureka.bgc WHERE placement_id = $1",
      [pl.id])).rows.map((r) => r.team_id);
    expect(items).toEqual([T.t1]);
    expect(await team("candidate", other.id)).toBe(T.t1);

    // Guards and FORCE are back on.
    const off = await db.admin.query(`SELECT tgrelid::regclass AS t, tgname FROM pg_trigger
      WHERE NOT tgisinternal AND tgenabled = 'D' AND tgrelid::regclass::text LIKE 'eureka.%'`);
    expect(off.rows).toEqual([]);
    const unforced = await db.admin.query(`SELECT relname FROM pg_class WHERE relnamespace = 'eureka'::regnamespace
      AND relname IN ('candidate','submission','interview','placement','bgc','checklist_item','job') AND NOT relforcerowsecurity`);
    expect(unforced.rows).toEqual([]);
  });
});

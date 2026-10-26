import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asUser, createTestDb, type TestDb } from "./db-harness.js";
import { T, U, seedFixtures } from "./fixtures.js";

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

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asUser, createTestDb, type TestDb } from "./db-harness.js";
import { T, U, seedFixtures } from "./fixtures.js";

/**
 * A team member reports to the team's lead (migration 0370), so hierarchy scope
 * follows teams built in the team drawer: an AD who adds a manager to their team
 * sees the manager's teams and Hot List.
 */
let db: TestDb;
const TM2 = randomUUID(); // led by m2, no members at first

beforeAll(async () => {
  db = await createTestDb();
  await seedFixtures(db.admin);
  await db.admin.query(`INSERT INTO eureka.team (id, name, lead_id) VALUES ($1,'M2 team',$2)`, [TM2, U.m2]);
}, 120_000);

afterAll(async () => {
  await db?.drop();
});

const managerOf = async (user: string) => (await db.admin.query<{ m: string }>(
  `SELECT manager_id AS m FROM eureka.reporting_line WHERE user_id = $1 AND valid @> now()`, [user])).rows.map((r) => r.m);
const teamIds = (user: string) => asUser(db.app, user, async (c) =>
  (await c.query<{ ids: string[] }>("SELECT authz.team_ids('candidate:read') AS ids")).rows[0]!.ids);

describe("team membership sets the reporting line (0370)", () => {
  it("joining a team makes the member report to its lead, and the lead's hierarchy covers their team", async () => {
    expect(await managerOf(U.l1)).toEqual([U.m1]);
    await db.admin.query(`INSERT INTO eureka.team_member (team_id, user_id) VALUES ($1,$2)`, [TM2, U.l1]);
    expect(await managerOf(U.l1)).toEqual([U.m2]);
    expect(await teamIds(U.m2)).toContain(T.t1);
    expect(await teamIds(U.m1)).not.toContain(T.t1);
    // The AD above m2 still covers it through the chain.
    expect(await teamIds(U.ad)).toEqual(expect.arrayContaining([TM2, T.t1]));
  });

  it("changing the lead moves every current member under the new lead", async () => {
    await db.admin.query(`UPDATE eureka.team SET lead_id = $2 WHERE id = $1`, [TM2, U.m1]);
    expect(await managerOf(U.l1)).toEqual([U.m1]);
    expect(await teamIds(U.m1)).toContain(T.t1);
  });

  it("a member who already reports to the lead keeps the same line", async () => {
    const before = (await db.admin.query(`SELECT count(*)::int AS n FROM eureka.reporting_line WHERE user_id = $1`, [U.l2])).rows[0].n;
    const team = randomUUID();
    await db.admin.query(`INSERT INTO eureka.team (id, name, lead_id) VALUES ($1,'M1 second',$2)`, [team, U.m1]);
    await db.admin.query(`INSERT INTO eureka.team_member (team_id, user_id) VALUES ($1,$2)`, [team, U.l2]);
    const after = (await db.admin.query(`SELECT count(*)::int AS n FROM eureka.reporting_line WHERE user_id = $1`, [U.l2])).rows[0].n;
    expect(after).toBe(before);
    expect(await managerOf(U.l2)).toEqual([U.m1]);
  });

  it("joining a team led by someone below you is refused as a cycle", async () => {
    // l3 reports to m2; putting m2 in l3's team would close a loop.
    const e = await db.admin.query(`INSERT INTO eureka.team_member (team_id, user_id) VALUES ($1,$2)`, [T.t3, U.m2])
      .then(() => "ok", (x: Error & { code?: string }) => `${x.code}:${x.message}`);
    expect(e).toBe("23514:cycle");
    expect(await managerOf(U.m2)).toEqual([U.ad]);
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asUser, createTestDb, type TestDb } from "./db-harness.js";
import { LOC, T, TECH_ID, U, seedFixtures } from "./fixtures.js";

/**
 * Interview Lead and coach assignments (migration 0220, docs/admin-api.md AD-11).
 * Fixture: ad <- il <- coach; coach coaches Team Anjali (t2), il Team Rohit (t1).
 */
let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
  await seedFixtures(db.admin);
}, 120_000);

afterAll(async () => {
  await db?.drop();
});

const err = (p: Promise<unknown>) => p.then(() => "ok", (e: Error & { code?: string }) => `${e.code}:${e.message}`);
const sorted = (xs: string[]) => [...xs].sort();
const arr = (user: string, sql: string, params: unknown[] = []) => asUser(db.app, user, async (c) =>
  sorted((await c.query<{ ids: string[] }>(sql, params)).rows[0]!.ids));
const call = (user: string, sql: string, params: unknown[]) => err(asUser(db.app, user, (c) => c.query(sql, params)));

describe("coached_hierarchy scope (0220)", () => {
  it("the Interview Lead covers teams coached by them and by coaches below them", async () => {
    expect(await arr(U.il, "SELECT authz.team_ids('candidate:read') AS ids")).toEqual(sorted([T.t1, T.t2]));
    expect(await arr(U.il, "SELECT authz.coached_team_ids('interview.feedback:create') AS ids")).toEqual(sorted([T.t1, T.t2]));
  });

  it("a coach still covers only their own coached teams", async () => {
    expect(await arr(U.coach, "SELECT authz.team_ids('candidate:read') AS ids")).toEqual([T.t2]);
    expect(await arr(U.coach, "SELECT authz.coached_team_ids('interview.feedback:create') AS ids")).toEqual([T.t2]);
  });

  it("RLS shows the Interview Lead candidates of coached teams only", async () => {
    const teams = await asUser(db.app, U.il, async (c) =>
      (await c.query<{ team_id: string }>("SELECT DISTINCT team_id FROM eureka.candidate")).rows.map((r) => r.team_id));
    expect(sorted(teams)).toEqual(sorted([T.t1, T.t2]));
  });

  it("the AD's hierarchy is unchanged: coaches below give no coached teams", async () => {
    expect(await arr(U.ad, "SELECT authz.coached_team_ids('interview.feedback:create') AS ids")).toEqual([]);
  });

  it("training batches trained by a coach below are covered for the Interview Lead", async () => {
    // Fixture row: skip the definer-only write guard (superuser, this transaction only).
    const c = await db.admin.connect();
    let b: { id: string } | undefined;
    try {
      await c.query("BEGIN; SET LOCAL session_replication_role = replica");
      ({ rows: [b] } = await c.query<{ id: string }>(
        `INSERT INTO eureka.batch (location_id, technology_id, start_month, created_by, trainer_id)
         VALUES ($1, $2, date '2031-05-01', $3, $4) RETURNING id`, [LOC.dallas, TECH_ID, U.admin, U.coach]));
      await c.query("COMMIT");
    } finally { c.release(); }
    expect(await arr(U.il, "SELECT authz.training_batch_ids('training:read') AS ids")).toContain(b!.id);
    expect(await arr(U.coach, "SELECT authz.training_batch_ids('training:read') AS ids")).toContain(b!.id);
    expect(await arr(U.l1, "SELECT authz.training_batch_ids('training:read') AS ids")).not.toContain(b!.id);
  });
});

describe("authz.assign_coach / unassign_coach (AD-11)", () => {
  const assign = (actor: string, coach: string, team: string) =>
    call(actor, "SELECT authz.assign_coach($1, $2)", [coach, team]);
  const unassign = (actor: string, coach: string, team: string) =>
    call(actor, "SELECT authz.unassign_coach($1, $2)", [coach, team]);

  it("the Interview Lead assigns a coach in their subtree to any team", async () => {
    expect(await assign(U.il, U.coach, T.t3)).toBe("ok");
  });

  it("refuses oneself, people outside the subtree and roles without coach:assign", async () => {
    expect(await assign(U.il, U.il, T.t3)).toBe("42501:self_change");
    expect(await assign(U.ad, U.coach, T.t3)).toBe("42501:not_permitted");
    expect(await assign(U.l1, U.coach, T.t3)).toBe("42501:not_permitted");
    expect(await assign(U.coach, U.coach, T.t3)).toBe("42501:not_permitted");
  });

  it("refuses non-coaches, unknown teams and duplicates", async () => {
    expect(await assign(U.admin, U.r1a, T.t3)).toBe("23514:not_a_coach");
    expect(await assign(U.admin, U.coach, "00000000-0000-0000-0000-000000009999")).toBe("P0002:team_not_found");
    expect(await assign(U.admin, U.coach, T.t2)).toBe("23505:already_assigned");
  });

  it("an org admin assigns and unassigns anyone holding a coach role, committed and visible to the coach", async () => {
    await asUser(db.app, U.admin, (c) => c.query("SELECT authz.assign_coach($1, $2)", [U.coach, T.t3]), true);
    expect(await arr(U.coach, "SELECT authz.team_ids('candidate:read') AS ids")).toEqual(sorted([T.t2, T.t3]));
    expect(await arr(U.il, "SELECT authz.team_ids('candidate:read') AS ids")).toEqual(sorted([T.t1, T.t2, T.t3]));

    await asUser(db.app, U.il, (c) => c.query("SELECT authz.unassign_coach($1, $2)", [U.coach, T.t3]), true);
    expect(await arr(U.coach, "SELECT authz.team_ids('candidate:read') AS ids")).toEqual([T.t2]);
    expect(await unassign(U.il, U.coach, T.t3)).toBe("P0002:not_assigned");
  });

  it("the org admin may assign the Interview Lead directly; the lead may not unassign themself", async () => {
    expect(await assign(U.admin, U.il, T.t3)).toBe("ok");
    expect(await unassign(U.il, U.il, T.t1)).toBe("42501:self_change");
  });

  it("the app role cannot write coach_assignment directly", async () => {
    expect(await call(U.admin, "INSERT INTO eureka.coach_assignment (coach_id, team_id) VALUES ($1, $2)", [U.coach, T.t3]))
      .toMatch(/^42501:permission denied/);
  });
});

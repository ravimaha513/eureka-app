import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { asUser, createTestDb, type TestDb } from "./db-harness.js";
import { LOC, T, U, seedFixtures, type FixtureCandidate } from "./fixtures.js";
import { newCandidate } from "./placement-seed.js";

/**
 * "Selected teams" visibility (migration 0240): a lead sees only their own
 * team's candidates unless one is Open to all teams or shared with their team.
 */
let db: TestDb;
let cand: FixtureCandidate;

beforeAll(async () => {
  db = await createTestDb();
  await seedFixtures(db.admin);
}, 120_000);

beforeEach(async () => {
  cand = await newCandidate(db, { teamId: T.t1, recruiterId: U.r1a, locationId: LOC.dallas });
});

afterAll(async () => {
  await db?.drop();
});

const err = (p: Promise<unknown>) => p.then(() => "ok", (e: Error & { code?: string }) => `${e.code}:${e.message}`);
const sees = (user: string, id: string) => asUser(db.app, user, async (c) =>
  (await c.query("SELECT 1 FROM eureka.candidate WHERE id = $1", [id])).rowCount === 1);
const share = (user: string, id: string, visibility: string, teams: string[] | null) =>
  asUser(db.app, user, (c) => c.query("SELECT authz.set_candidate_visibility($1, $2, $3::uuid[])", [id, visibility, teams]), true);

describe("candidate_read with selected teams (0240)", () => {
  it("another team's lead and recruiter see a team-only candidate nowhere", async () => {
    expect(await sees(U.l2, cand.id)).toBe(false);
    expect(await sees(U.r2a, cand.id)).toBe(false);
  });

  it("the picked team's lead and recruiters see it; other teams still don't", async () => {
    await share(U.l1, cand.id, "selected_teams", [T.t2]);
    expect(await sees(U.l2, cand.id)).toBe(true);
    expect(await sees(U.r2a, cand.id)).toBe(true);
    expect(await sees(U.l3, cand.id)).toBe(false);
    expect(await sees(U.r3a, cand.id)).toBe(false);
    // The manager above the picked team's lead sees it through that team.
    expect(await sees(U.m1, cand.id)).toBe(true);
  });

  it("shares count only while the candidate is marketable, like Open to all teams", async () => {
    const held = await newCandidate(db, { teamId: T.t1, recruiterId: U.r1a, locationId: LOC.dallas, marketingStatus: "on_hold" });
    await share(U.l1, held.id, "selected_teams", [T.t2]);
    expect(await sees(U.l2, held.id)).toBe(false);
    expect(await sees(U.l1, held.id)).toBe(true);
  });

  it("the share reaches submission:create, as Open to all teams does", async () => {
    await share(U.l1, cand.id, "selected_teams", [T.t2]);
    const ok = await asUser(db.app, U.r2a, async (c) =>
      (await c.query<{ v: boolean }>("SELECT authz.candidate_visible($1, 'submission:create') AS v", [cand.id])).rows[0]!.v);
    expect(ok).toBe(true);
  });

  it("going back to team only removes the shares", async () => {
    await share(U.l1, cand.id, "selected_teams", [T.t2, T.t3]);
    await share(U.l1, cand.id, "team", null);
    expect(await sees(U.l2, cand.id)).toBe(false);
    const n = await db.admin.query("SELECT 1 FROM eureka.candidate_team_share WHERE candidate_id = $1", [cand.id]);
    expect(n.rowCount).toBe(0);
  });
});

describe("authz.set_candidate_visibility (0240)", () => {
  it("a lead of a team it is shared with may not change it (403, not 404)", async () => {
    await share(U.l1, cand.id, "selected_teams", [T.t2]);
    expect(await err(share(U.l2, cand.id, "all_teams", null))).toMatch(/not_permitted/);
  });

  it("a lead who cannot see the candidate gets not found", async () => {
    expect(await err(share(U.l3, cand.id, "selected_teams", [T.t3]))).toMatch(/candidate_not_found/);
  });

  it("a recruiter cannot share their own candidate", async () => {
    expect(await err(share(U.r1a, cand.id, "selected_teams", [T.t2]))).toMatch(/not_permitted/);
  });

  it("needs at least one team other than the candidate's own", async () => {
    expect(await err(share(U.l1, cand.id, "selected_teams", [T.t1]))).toMatch(/teams_required/);
    expect(await err(share(U.l1, cand.id, "selected_teams", []))).toMatch(/teams_required/);
  });

  it("rejects unknown teams and teams with another visibility", async () => {
    expect(await err(share(U.l1, cand.id, "selected_teams", ["00000000-0000-0000-0000-00000000beef"]))).toMatch(/invalid_team/);
    expect(await err(share(U.l1, cand.id, "all_teams", [T.t2]))).toMatch(/teams_not_allowed/);
  });

  it("records who shared, server-side", async () => {
    await share(U.l1, cand.id, "selected_teams", [T.t2]);
    const r = await db.admin.query<{ shared_by: string }>(
      "SELECT shared_by FROM eureka.candidate_team_share WHERE candidate_id = $1", [cand.id]);
    expect(r.rows.map((x) => x.shared_by)).toEqual([U.l1]);
  });

  it("clients cannot write shares directly", async () => {
    expect(await err(asUser(db.app, U.l1, (c) =>
      c.query("INSERT INTO eureka.candidate_team_share (candidate_id, team_id, shared_by) VALUES ($1,$2,$3)", [cand.id, T.t2, U.l1]))))
      .toMatch(/^42501:/);
  });
});

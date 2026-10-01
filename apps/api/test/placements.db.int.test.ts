import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activityVisible, resolveScope, type ActivityRef } from "@eureka/shared";
import { asUser, createTestDb, type TestDb } from "./db-harness.js";
import { LOC, T, U, seedFixtures, toUserAccess } from "./fixtures.js";
import { createPlacement, newCandidate, selectedSubmission, transitionPlacement } from "./placement-seed.js";

/**
 * Database-only checks for migration 0022 (placements): every rule holds with
 * the API removed (design B8).
 */
let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
  await seedFixtures(db.admin);
}, 120_000);

afterAll(async () => {
  await db?.drop();
});

const users = Object.keys(U) as (keyof typeof U)[];
const r1aCandidate = (extra: Partial<Parameters<typeof newCandidate>[1]> = {}) =>
  newCandidate(db, { teamId: T.t1, recruiterId: U.r1a, locationId: LOC.dallas, ...extra });
const candStatus = async (id: string) =>
  (await db.admin.query(`SELECT marketing_status, bench_since FROM eureka.candidate WHERE id = $1`, [id])).rows[0];
const placement = async (id: string) => (await db.admin.query(`SELECT * FROM eureka.placement WHERE id = $1`, [id])).rows[0];
const outbox = async (id: string) =>
  (await db.admin.query(`SELECT type, payload FROM eureka.outbox_event WHERE aggregate_id = $1 ORDER BY created_at, type`, [id])).rows;

/** Superuser write with triggers off (test setup only). */
async function force(sql: string, params: unknown[]) {
  const c = await db.admin.connect();
  try {
    await c.query("BEGIN");
    await c.query("SET LOCAL session_replication_role = replica");
    await c.query(sql, params);
    await c.query("COMMIT");
  } finally {
    c.release();
  }
}

/** A fresh candidate of r1a with a selected submission by r1a. */
async function ready(extra: Partial<Parameters<typeof newCandidate>[1]> = {}) {
  const cand = await r1aCandidate(extra);
  const sub = await selectedSubmission(db, U.r1a, cand.id);
  return { cand, sub };
}

describe("create_placement", () => {
  it("creates from a selected submission with database-set snapshots, side effects and an outbox row", async () => {
    const { cand, sub } = await ready();
    const contacts = [{ kind: "vendor_poc", name: "Vee Poc", email: "vee@vendor.example", phone: "+14695550100" }];
    const r = await createPlacement(db, U.r1a, sub, { contacts });
    expect(r.isFirst).toBe(true);
    const p = await placement(r.id);
    const s = (await db.admin.query(`SELECT * FROM eureka.submission WHERE id = $1`, [sub])).rows[0];
    expect([p.candidate_id, p.recruiter_id, p.team_id, p.location_id, p.client_id, p.vendor_id])
      .toEqual([s.candidate_id, s.recruiter_id, s.team_id, s.location_id, s.client_id, s.vendor_id]);
    expect([p.status, p.created_by, p.is_first_placement, Number(p.rate)]).toEqual(["confirmed", U.r1a, true, 60]);
    expect((await candStatus(cand.id)).marketing_status).toBe("confirmation");
    const c = (await db.admin.query(`SELECT kind, name, email, phone FROM eureka.placement_contact WHERE placement_id = $1`, [r.id])).rows;
    expect(c).toEqual([{ kind: "vendor_poc", name: "Vee Poc", email: "vee@vendor.example", phone: "+14695550100" }]);
    const ev = await outbox(r.id);
    expect(ev).toHaveLength(1);
    expect(ev[0].type).toBe("placement.created");
    // Ids and states only: no names, rates, emails or phones.
    expect(Object.keys(ev[0].payload).sort()).toEqual(["candidateId", "isFirstPlacement", "notify", "placementId", "status", "submissionId"]);
    expect(JSON.stringify(ev[0].payload)).not.toMatch(/vee|Placed|PlCand|rate|email|phone/i);
  });

  it("a full_of_interviews candidate can be placed (moves to confirmation)", async () => {
    const { cand, sub } = await ready({ marketingStatus: "full_of_interviews" });
    await createPlacement(db, U.r1a, sub);
    expect((await candStatus(cand.id)).marketing_status).toBe("confirmation");
  });

  it.each([
    ["no user context", null, /submission_not_found/],
    ["another recruiter of the same team (not visible: own scope)", U.r1b, /submission_not_found/],
    ["another team's recruiter", U.r3a, /submission_not_found/],
    ["location admin (reads, cannot create)", U.locD, /not_permitted/],
    ["CEO (org read only)", U.ceo, /not_permitted/],
    ["HR (no submission:read)", U.hr, /submission_not_found/],
  ])("refuses %s", async (_n, actor, err) => {
    const { cand, sub } = await ready();
    await expect(createPlacement(db, actor, sub)).rejects.toThrow(err);
    expect((await candStatus(cand.id)).marketing_status).toBe("active");
  });

  it("the team lead and the manager above may place the recruiter's submission", async () => {
    for (const actor of [U.l1, U.m1, U.ad]) {
      const { sub } = await ready();
      const r = await createPlacement(db, actor, sub);
      const p = await placement(r.id);
      expect([p.recruiter_id, p.created_by]).toEqual([U.r1a, actor]); // snapshot from the submission
    }
    const { sub } = await ready();
    await expect(createPlacement(db, U.l2, sub)).rejects.toThrow(/submission_not_found/);
    await expect(createPlacement(db, U.m2, sub)).rejects.toThrow(/submission_not_found/);
  });

  it("NULL and invalid arguments are refused", async () => {
    const { sub } = await ready();
    await expect(createPlacement(db, U.r1a, null)).rejects.toThrow(/submission_not_found/);
    await expect(createPlacement(db, U.r1a, sub, { type: null })).rejects.toThrow(/invalid_placement/);
    await expect(createPlacement(db, U.r1a, sub, { type: "fte" })).rejects.toThrow(/invalid_placement/);
    await expect(createPlacement(db, U.r1a, sub, { workMode: null })).rejects.toThrow(/invalid_placement/);
    await expect(createPlacement(db, U.r1a, sub, { start: null })).rejects.toThrow(/invalid_placement/);
    await expect(createPlacement(db, U.r1a, sub, { contacts: { kind: "vendor_poc" } })).rejects.toThrow(/invalid_placement/);
    await expect(createPlacement(db, U.r1a, sub, { contacts: [{ kind: "vendor_poc" }] })).rejects.toThrow(/invalid_placement/);
    await expect(createPlacement(db, U.r1a, sub, { contacts: [{ kind: "vendor_poc", name: 5 }] })).rejects.toThrow(/invalid_placement/);
    await expect(createPlacement(db, U.r1a, sub, { contacts: Array(11).fill({ kind: "vendor_poc", name: "A" }) }))
      .rejects.toThrow(/invalid_placement/);
  });

  it.each([
    ["rate 0", { rate: 0 }, /placement_rate_check/],
    ["rate above the sane maximum", { rate: 5000 }, /placement_rate_check/],
    ["a long city", { city: "x".repeat(81) }, /placement_project_city_check/],
    ["a malformed state", { state: "T3xas!" }, /placement_project_state_check/],
    ["a start date far away", { start: "2300-01-01" }, /placement_tentative_start_check/],
    ["a bad contact email", { contacts: [{ kind: "vendor_poc", name: "A", email: "not-an-email" }] }, /placement_contact_email_check/],
    ["a bad contact phone", { contacts: [{ kind: "vendor_poc", name: "A", phone: "555" }] }, /placement_contact_phone_check/],
    ["an unknown contact kind", { contacts: [{ kind: "boss", name: "A" }] }, /placement_contact_kind_check/],
  ])("table CHECKs refuse %s", async (_n, args, err) => {
    const { sub } = await ready();
    await expect(createPlacement(db, U.r1a, sub, args)).rejects.toThrow(err);
  });

  it("only a selected submission, one active placement per submission", async () => {
    const cand = await r1aCandidate();
    const notYet = await selectedSubmission(db, U.r1a, cand.id, "interview_completed");
    await expect(createPlacement(db, U.r1a, notYet)).rejects.toThrow(/submission_not_selected/);
    const sub = await selectedSubmission(db, U.r1a, cand.id);
    const first = await createPlacement(db, U.r1a, sub);
    await expect(createPlacement(db, U.r1a, sub)).rejects.toThrow(/placement_exists/);
    // A second submission of the same candidate: the candidate is now in confirmation.
    const other = await selectedSubmission(db, U.r1a, cand.id);
    await expect(createPlacement(db, U.r1a, other)).rejects.toThrow(/candidate_not_available/);
    // After a backout the submission can be placed again.
    await transitionPlacement(db, U.r1a, first.id, "backout", "Candidate declined");
    const again = await createPlacement(db, U.r1a, sub);
    expect(again.isFirst).toBe(true); // a backout never counts (PL-3)
  });

  it.each(["on_hold", "stopped", "bench", "in_training", "terminated", "placed"])("refuses a candidate in %s", async (status) => {
    const { cand, sub } = await ready();
    await force(`UPDATE eureka.candidate SET marketing_status = $2 WHERE id = $1`, [cand.id, status]);
    await expect(createPlacement(db, U.r1a, sub)).rejects.toThrow(/candidate_not_available/);
  });

  it("Open-to-all-teams: another team's recruiter places its own submission; the candidate must stay visible", async () => {
    const cand = await newCandidate(db, { teamId: T.t3, recruiterId: U.r3a, locationId: LOC.austin, visibility: "all_teams" });
    const sub = await selectedSubmission(db, U.r2a, cand.id);
    const hidden = await selectedSubmission(db, U.r2a, (await newCandidate(db,
      { teamId: T.t3, recruiterId: U.r3a, locationId: LOC.austin, visibility: "all_teams" })).id);
    const r = await createPlacement(db, U.r2a, sub);
    expect((await placement(r.id)).team_id).toBe(T.t2);
    // The owning team cannot place r2a's submission (no update right on it).
    await expect(createPlacement(db, U.l3, hidden)).rejects.toThrow(/not_permitted/);
    // Visibility withdrawn: r2a still owns the submission but no longer sees the candidate.
    await force(`UPDATE eureka.candidate SET visibility = 'team' WHERE id = (SELECT candidate_id FROM eureka.submission WHERE id = $1)`, [hidden]);
    await expect(createPlacement(db, U.r2a, hidden)).rejects.toThrow(/not_permitted/);
  });
});

describe("transition_placement", () => {
  it("walks confirmed → joined one step at a time with side effects", async () => {
    const { cand, sub } = await ready();
    const { id } = await createPlacement(db, U.r1a, sub);
    for (const to of ["paperwork", "bgc", "ready"]) expect(await transitionPlacement(db, U.r1a, id, to)).toBe(to);
    expect(await db.admin.query(`SELECT 1 FROM eureka.assignment WHERE placement_id = $1`, [id]).then((r) => r.rowCount)).toBe(0);
    expect(await transitionPlacement(db, U.r1a, id, "joined")).toBe("joined");
    const p = await placement(id);
    expect([p.status, p.status_changed_by, p.joined_at !== null]).toEqual(["joined", U.r1a, true]);
    expect((await candStatus(cand.id)).marketing_status).toBe("placed");
    const a = (await db.admin.query(`SELECT assignment_no, start_date, end_date, end_reason FROM eureka.assignment WHERE placement_id = $1`, [id])).rows;
    expect(a).toHaveLength(1);
    expect([a[0].assignment_no, a[0].end_date, a[0].end_reason]).toEqual([1, null, null]);
    const ev = await outbox(id);
    expect(ev.map((e) => e.type)).toEqual(["placement.created", ...Array(4).fill("placement.state_changed")]);
    expect(ev.slice(1).map((e) => `${e.payload.from}>${e.payload.to}`))
      .toEqual(["confirmed>paperwork", "paperwork>bgc", "bgc>ready", "ready>joined"]);
  });

  it.each([
    ["NULL target", [], null, null, /invalid_transition/],
    ["unknown target", [], "hired", null, /invalid_transition/],
    ["a skipped step", [], "bgc", null, /invalid_transition/],
    ["joining from confirmed", [], "joined", null, /invalid_transition/],
    ["going backward", ["paperwork"], "confirmed", null, /invalid_transition/],
    ["staying put", ["paperwork"], "paperwork", null, /invalid_transition/],
    ["a backout without a reason", [], "backout", null, /reason_required/],
    ["a backout with a blank reason", [], "backout", "   ", /reason_required/],
  ])("refuses %s", async (_n, setup, to, reason, err) => {
    const { sub } = await ready();
    const { id } = await createPlacement(db, U.r1a, sub);
    for (const s of setup) await transitionPlacement(db, U.r1a, id, s);
    await expect(transitionPlacement(db, U.r1a, id, to, reason)).rejects.toThrow(err);
  });

  it("refuses NULL ids, missing users and out-of-scope callers", async () => {
    const { sub } = await ready();
    const { id } = await createPlacement(db, U.r1a, sub);
    await expect(transitionPlacement(db, U.r1a, null, "paperwork")).rejects.toThrow(/placement_not_found/);
    await expect(transitionPlacement(db, null, id, "paperwork")).rejects.toThrow(/placement_not_found/);
    await expect(transitionPlacement(db, U.r1b, id, "paperwork")).rejects.toThrow(/placement_not_found/);
    await expect(transitionPlacement(db, U.l3, id, "paperwork")).rejects.toThrow(/placement_not_found/);
    await expect(transitionPlacement(db, U.hr, id, "paperwork")).rejects.toThrow(/not_permitted/); // org read only
    await expect(transitionPlacement(db, U.locD, id, "paperwork")).rejects.toThrow(/not_permitted/);
    // bgc_failed needs placement.bgc_status:update (Manager, AD).
    await expect(transitionPlacement(db, U.r1a, id, "bgc_failed", "x")).rejects.toThrow(/not_permitted/);
    await expect(transitionPlacement(db, U.l1, id, "bgc_failed", "x")).rejects.toThrow(/not_permitted/);
    expect(await transitionPlacement(db, U.l1, id, "paperwork")).toBe("paperwork");
    expect(await transitionPlacement(db, U.m1, id, "bgc_failed", "Report failed")).toBe("bgc_failed");
  });

  it("terminal states stay terminal", async () => {
    for (const end of ["backout", "bgc_failed"]) {
      const { sub } = await ready();
      const { id } = await createPlacement(db, U.r1a, sub);
      await transitionPlacement(db, U.m1, id, end, "reason");
      for (const to of ["confirmed", "paperwork", "joined", "backout", "bgc_failed"]) {
        await expect(transitionPlacement(db, U.m1, id, to, "again")).rejects.toThrow(/invalid_transition/);
      }
    }
  });

  it("backout and bgc_failed before joining put the candidate back on the market", async () => {
    for (const [end, by] of [["backout", U.r1a], ["bgc_failed", U.m1]] as const) {
      const { cand, sub } = await ready();
      const { id } = await createPlacement(db, U.r1a, sub);
      await transitionPlacement(db, U.r1a, id, "paperwork");
      await transitionPlacement(db, by, id, end, "Did not proceed");
      expect((await candStatus(cand.id)).marketing_status).toBe("active");
      expect((await placement(id)).status_reason).toBe("Did not proceed");
      expect((await db.admin.query(`SELECT 1 FROM eureka.assignment WHERE placement_id = $1`, [id])).rowCount).toBe(0);
    }
  });

  it("bgc_failed after joining ends the assignment and benches the candidate; numbering continues per person", async () => {
    const { cand, sub } = await ready();
    const { id } = await createPlacement(db, U.r1a, sub);
    for (const to of ["paperwork", "bgc", "ready", "joined"]) await transitionPlacement(db, U.r1a, id, to);
    await expect(transitionPlacement(db, U.r1a, id, "backout", "too late")).rejects.toThrow(/invalid_transition/);
    await transitionPlacement(db, U.ad, id, "bgc_failed", "Adverse report");
    const a = (await db.admin.query(`SELECT end_date, end_reason FROM eureka.assignment WHERE placement_id = $1`, [id])).rows[0];
    expect(a.end_reason).toBe("bgc_failed");
    expect(a.end_date).not.toBeNull();
    const cs = await candStatus(cand.id);
    expect(cs.marketing_status).toBe("bench");
    expect(cs.bench_since).not.toBeNull();

    // Back to market manually, placed again: not a first placement, assignment #2.
    await asUser(db.app, U.r1a, (c) => c.query(`SELECT authz.transition_candidate($1, 'active')`, [cand.id]), true);
    const sub2 = await selectedSubmission(db, U.r1a, cand.id);
    const second = await createPlacement(db, U.r1a, sub2);
    expect(second.isFirst).toBe(false);
    for (const to of ["paperwork", "bgc", "ready", "joined"]) await transitionPlacement(db, U.r1a, second.id, to);
    const nos = (await db.admin.query(
      `SELECT a.assignment_no FROM eureka.assignment a JOIN eureka.placement p ON p.id = a.placement_id
       WHERE p.candidate_id = $1 ORDER BY a.assignment_no`, [cand.id])).rows.map((r) => r.assignment_no);
    expect(nos).toEqual([1, 2]);
  });

  it("first-placement detection: only earlier backouts are ignored", async () => {
    // bgc_failed before joining is not a backout, so it counts as an earlier placement (PL-3).
    const { cand, sub } = await ready();
    const first = await createPlacement(db, U.r1a, sub);
    await transitionPlacement(db, U.m1, first.id, "bgc_failed", "Failed");
    const sub2 = await selectedSubmission(db, U.r1a, cand.id);
    expect((await createPlacement(db, U.r1a, sub2)).isFirst).toBe(false);
  });

  it("joined needs the candidate in confirmation", async () => {
    const { cand, sub } = await ready();
    const { id } = await createPlacement(db, U.r1a, sub);
    for (const to of ["paperwork", "bgc", "ready"]) await transitionPlacement(db, U.r1a, id, to);
    await force(`UPDATE eureka.candidate SET marketing_status = 'terminated' WHERE id = $1`, [cand.id]);
    await expect(transitionPlacement(db, U.r1a, id, "joined")).rejects.toThrow(/invalid_transition/);
    // Backing out still works and leaves the terminated candidate alone.
    await transitionPlacement(db, U.r1a, id, "backout", "Left");
    expect((await candStatus(cand.id)).marketing_status).toBe("terminated");
  });
});

describe("candidate transitions while a placement is open", () => {
  it("manual changes are refused until the placement joins or backs out", async () => {
    const { cand, sub } = await ready();
    const { id } = await createPlacement(db, U.r1a, sub);
    for (const to of ["active", "terminated"]) {
      await expect(asUser(db.app, U.r1a, (c) => c.query(`SELECT authz.transition_candidate($1, $2)`, [cand.id, to])))
        .rejects.toThrow(/placement_open/);
    }
    expect((await asUser(db.app, U.r1a, (c) => c.query(`SELECT authz.candidate_has_open_placement($1) AS o`, [cand.id]))).rows[0].o).toBe(true);
    // Not readable: the helper says nothing.
    expect((await asUser(db.app, U.r3a, (c) => c.query(`SELECT authz.candidate_has_open_placement($1) AS o`, [cand.id]))).rows[0].o).toBe(false);
    await transitionPlacement(db, U.r1a, id, "backout", "Declined");
    expect((await asUser(db.app, U.r1a, (c) => c.query(`SELECT authz.transition_candidate($1, 'on_hold') AS s`, [cand.id]), true)).rows[0].s).toBe("on_hold");
  });
});

describe("write paths are closed", () => {
  it("the app cannot write placement tables or call the internal status function", async () => {
    const { sub } = await ready();
    const { id } = await createPlacement(db, U.r1a, sub);
    const attempts = [
      `INSERT INTO eureka.placement (submission_id, candidate_id, person_id, recruiter_id, client_id, placement_type, work_mode, tentative_start, is_first_placement, created_by)
       SELECT id, candidate_id, gen_random_uuid(), recruiter_id, client_id, 'w2', 'onsite', '2031-01-01', true, recruiter_id FROM eureka.submission WHERE id = '${sub}'`,
      `UPDATE eureka.placement SET status = 'joined' WHERE id = '${id}'`,
      `UPDATE eureka.placement SET is_first_placement = false WHERE id = '${id}'`,
      `DELETE FROM eureka.placement WHERE id = '${id}'`,
      `INSERT INTO eureka.placement_contact (placement_id, kind, name) VALUES ('${id}', 'vendor_poc', 'X')`,
      `INSERT INTO eureka.assignment (person_id, placement_id, assignment_no, start_date) SELECT person_id, id, 9, now() FROM eureka.placement WHERE id = '${id}'`,
      `INSERT INTO eureka.outbox_event (type, aggregate_type, aggregate_id, payload) VALUES ('placement.created', 'placement', '${id}', '{}')`,
      `SELECT * FROM eureka.outbox_event`,
      `SELECT authz.candidate_status_by_placement('${id}', 'placed')`,
    ];
    for (const sql of attempts) {
      await expect(asUser(db.app, U.m1, (c) => c.query(sql)), sql).rejects.toThrow(/permission denied/);
    }
  });

  it("the write guard refuses even the table owner path outside the functions", async () => {
    const { sub } = await ready();
    const { id } = await createPlacement(db, U.r1a, sub);
    await expect(db.admin.query(`UPDATE eureka.placement SET status = 'joined' WHERE id = $1`, [id]))
      .rejects.toThrow(/only through placement functions/);
    await expect(db.admin.query(`DELETE FROM eureka.outbox_event WHERE aggregate_id = $1`, [id]))
      .rejects.toThrow(/only through placement functions/);
  });

  it("new functions pin search_path and are not executable by PUBLIC", async () => {
    const { rows } = await db.admin.query(`
      SELECT p.oid::regprocedure::text AS sig, p.proconfig, has_function_privilege('eureka_app', p.oid, 'EXECUTE') AS app
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE p.proname IN ('create_placement','transition_placement','candidate_status_by_placement',
                          'candidate_has_open_placement','placement_write_guard','idempotency_key_guard')`);
    expect(rows).toHaveLength(6);
    for (const r of rows) expect(r.proconfig, r.sig).toContain("search_path=pg_catalog, pg_temp");
    const app = Object.fromEntries(rows.map((r) => [r.sig.split("(")[0], r.app]));
    expect(app["authz.candidate_status_by_placement"]).toBe(false);
    expect(app["authz.create_placement"]).toBe(true);
  });
});

describe("idempotency_key table", () => {
  it("rows are private to their user, response cannot be preset and fields are immutable", async () => {
    const h = "a".repeat(64);
    await asUser(db.app, U.r1a, (c) => c.query(
      `INSERT INTO eureka.idempotency_key (key, user_id, endpoint, request_hash) VALUES ('k-1', $1, 'e', $2)`, [U.r1a, h]), true);
    expect((await asUser(db.app, U.r1b, (c) => c.query(`SELECT * FROM eureka.idempotency_key`))).rowCount).toBe(0);
    await expect(asUser(db.app, U.r1b, (c) => c.query(
      `INSERT INTO eureka.idempotency_key (key, user_id, endpoint, request_hash) VALUES ('k-1', $1, 'e', $2)`, [U.r1a, h])))
      .rejects.toThrow(/row-level security/);
    await expect(asUser(db.app, U.r1a, (c) => c.query(
      `INSERT INTO eureka.idempotency_key (key, user_id, endpoint, request_hash, response) VALUES ('k-2', $1, 'e', $2, '{}')`, [U.r1a, h])))
      .rejects.toThrow(/permission denied/);
    await expect(asUser(db.app, U.r1a, (c) => c.query(`UPDATE eureka.idempotency_key SET request_hash = $1`, ["b".repeat(64)])))
      .rejects.toThrow(/permission denied/);
    await asUser(db.app, U.r1a, (c) => c.query(`UPDATE eureka.idempotency_key SET response = '{"id":1}' WHERE key = 'k-1'`), true);
    await expect(asUser(db.app, U.r1a, (c) => c.query(`UPDATE eureka.idempotency_key SET response = '{"id":2}' WHERE key = 'k-1'`)))
      .rejects.toThrow(/immutable/);
    await expect(asUser(db.app, U.r1a, (c) => c.query(
      `INSERT INTO eureka.idempotency_key (key, user_id, endpoint, request_hash) VALUES ('has space', $1, 'e', $2)`, [U.r1a, h])))
      .rejects.toThrow(/idempotency_key_key_check/);
  });
});

describe("RLS differential: placement visibility in the database matches the engine", () => {
  const made: (ActivityRef & { id: string })[] = [];

  beforeAll(async () => {
    const plan: { actor: string; cand: Parameters<typeof newCandidate>[1] }[] = [
      { actor: U.r1a, cand: { teamId: T.t1, recruiterId: U.r1a, locationId: LOC.dallas } },
      { actor: U.r1b, cand: { teamId: T.t1, recruiterId: U.r1b, locationId: LOC.austin } },
      { actor: U.l1, cand: { teamId: T.t1, recruiterId: null, locationId: LOC.dallas } },
      { actor: U.r2a, cand: { teamId: T.t2, recruiterId: U.r2a, locationId: LOC.austin } },
      { actor: U.r2a, cand: { teamId: T.t3, recruiterId: U.r3a, locationId: LOC.dallas, visibility: "all_teams" } },
      { actor: U.r3a, cand: { teamId: T.t3, recruiterId: U.r3a, locationId: LOC.austin } },
    ];
    for (const { actor, cand } of plan) {
      const c = await newCandidate(db, cand);
      const sub = await selectedSubmission(db, actor, c.id);
      const { id } = await createPlacement(db, actor, sub, { contacts: [{ kind: "client_manager", name: "M" }] });
      const p = await placement(id);
      const cs = await candStatus(c.id);
      made.push({ id, recruiterId: p.recruiter_id, teamId: p.team_id, locationId: p.location_id,
        candidate: { ...c, marketingStatus: cs.marketing_status } });
    }
  }, 60_000);

  it.each(users)("%s", async (key) => {
    const scope = resolveScope(toUserAccess(key), "placement:read");
    const ids = new Set(made.map((m) => m.id));
    const seen = await asUser(db.app, U[key], async (c) => ({
      placements: (await c.query<{ id: string }>(`SELECT id FROM eureka.placement`)).rows.map((r) => r.id).filter((i) => ids.has(i)).sort(),
      contacts: (await c.query<{ placement_id: string }>(`SELECT DISTINCT placement_id FROM eureka.placement_contact`)).rows
        .map((r) => r.placement_id).filter((i) => ids.has(i)).sort(),
    }));
    const expected = made.filter((m) => activityVisible(scope, m)).map((m) => m.id).sort();
    expect(seen.placements).toEqual(expected);
    expect(seen.contacts).toEqual(expected);
  });

  it("the read policy resolves candidate ownership once per statement", async () => {
    const { rows } = await db.admin.query(`SELECT pg_get_expr(polqual, polrelid) AS def FROM pg_policy WHERE polname = 'placement_read'`);
    expect(rows[0].def).not.toMatch(/candidate_owned\(/);
    expect(rows[0].def).toMatch(/owned_candidate_ids/);
  });
});

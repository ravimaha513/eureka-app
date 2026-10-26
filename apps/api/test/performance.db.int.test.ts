import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PERFORMANCE_BELOW_TARGET_JOB, performanceBelowTargetJob } from "../src/worker/jobs/performance-below-target.js";
import { deliverEvent } from "../src/worker/jobs/outbox.js";
import { silentLogger } from "../src/worker/log.js";
import { JobRunner } from "../src/worker/runner.js";
import { DELIVERED_TYPES, EVENT_SPECS, INBOX_TYPES } from "../src/worker/notify-types.js";
import { asUser, createTestDb, type TestDb } from "./db-harness.js";
import { CLIENT_ID, LOC, T, U, seedFixtures } from "./fixtures.js";
import { newCandidate } from "./placement-seed.js";
import { emitEvent, workerCtx } from "./notification-seed.js";

/**
 * Recruiter performance in the database (migrations 0110-0112,
 * docs/performance-api.md): the scope function, target RLS and definer
 * functions, the designation change, the below-target producer and its
 * notification registry branch, and function hygiene (rules 1-7).
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

const scopeIds = (user: string, perm: string) => asUser(db.app, user, async (c) =>
  sorted((await c.query<{ ids: string[] }>("SELECT authz.scope_user_ids($1) AS ids", [perm])).rows[0]!.ids));

const setTarget = (actor: string, user: string, kind: string, start: string, sub: number | null, int: number | null = null, pl: number | null = null) =>
  asUser(db.app, actor, async (c) => (await c.query<{ target_id: string; created: boolean }>(
    "SELECT * FROM authz.performance_target_set($1, $2, $3::date, $4, $5, $6)", [user, kind, start, sub, int, pl])).rows[0]!, true);

const visibleTargets = (user: string) => asUser(db.app, user, async (c) =>
  sorted((await c.query<{ id: string }>("SELECT id FROM eureka.performance_target")).rows.map((r) => r.id)));

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

/** A submission by `actor` (snapshots from the app path), back-dated to `at`. */
async function submit(actor: string, at: string, team = T.t1): Promise<string> {
  const cand = await newCandidate(db, { teamId: team, recruiterId: actor, locationId: LOC.dallas });
  const id = await asUser(db.app, actor, async (c) => (await c.query<{ id: string }>(
    `INSERT INTO eureka.submission (candidate_id, job_title, client_id) VALUES ($1,'Java Developer',$2) RETURNING id`,
    [cand.id, CLIENT_ID])).rows[0]!.id, true);
  await force("UPDATE eureka.submission SET submitted_at = $2 WHERE id = $1", [id, at]);
  return id;
}

describe("authz.scope_user_ids (0110)", () => {
  it("own, team and hierarchy cover the people the spec names", async () => {
    expect(await scopeIds(U.r1a, "performance:read")).toEqual([U.r1a]);
    expect(await scopeIds(U.l1, "performance:read")).toEqual(sorted([U.l1, U.r1a, U.r1b]));
    expect(await scopeIds(U.m1, "performance:read")).toEqual(sorted([U.m1, U.l1, U.l2, U.r1a, U.r1b, U.r2a]));
    // The AD's subtree includes Interview Prep (il and the coach below them).
    expect(await scopeIds(U.ad, "performance:read")).toEqual(sorted([U.ad, U.m1, U.m2, U.l1, U.l2, U.l3, U.r1a, U.r1b, U.r2a, U.r3a, U.il, U.coach]));
    // Org scope is not expanded (callers test has_org first); no grant: nobody.
    expect(await scopeIds(U.ceo, "performance:read")).toEqual([]);
    expect(await scopeIds(U.hr, "performance:read")).toEqual([]);
    expect(await scopeIds(U.r1a, "designation:change")).toEqual([]);
    expect(await scopeIds(U.m1, "designation:change")).toEqual(sorted([U.m1, U.l1, U.l2, U.r1a, U.r1b, U.r2a]));
  });

  it("location scope: members of teams at the location and users based there", async () => {
    expect(await scopeIds(U.locA, "performance:read")).toEqual([]);
    await db.admin.query("UPDATE eureka.team SET location_id = $1 WHERE id = $2", [LOC.austin, T.t2]);
    await db.admin.query("UPDATE eureka.app_user SET primary_location_id = $1 WHERE id = $2", [LOC.austin, U.r3a]);
    try {
      expect(await scopeIds(U.locA, "performance:read")).toEqual(sorted([U.r2a, U.r3a]));
    } finally {
      await db.admin.query("UPDATE eureka.team SET location_id = NULL WHERE id = $1", [T.t2]);
      await db.admin.query("UPDATE eureka.app_user SET primary_location_id = NULL WHERE id = $1", [U.r3a]);
    }
  });

  it("ended memberships no longer count", async () => {
    await db.admin.query("UPDATE eureka.team_member SET valid = tstzrange(lower(valid), now()) WHERE user_id = $1 AND team_id = $2", [U.r1b, T.t1]);
    try {
      expect(await scopeIds(U.l1, "performance:read")).toEqual(sorted([U.l1, U.r1a]));
    } finally {
      await db.admin.query("UPDATE eureka.team_member SET valid = tstzrange(lower(valid), NULL) WHERE user_id = $1 AND team_id = $2", [U.r1b, T.t1]);
    }
  });
});

describe("performance targets (0110)", () => {
  let tR1a = "";
  let tR3a = "";
  let tL1 = "";

  it("managers and associate directors set targets for their hierarchy, never for themselves", async () => {
    const a = await setTarget(U.m1, U.r1a, "month", "2026-05-01", 10, 4, 1);
    expect(a.created).toBe(true);
    tR1a = a.target_id;
    // Upsert: the same person, kind and start replaces the counts.
    const b = await setTarget(U.m1, U.r1a, "month", "2026-05-01", 12, null, 2);
    expect(b).toEqual({ target_id: tR1a, created: false });
    tL1 = (await setTarget(U.ad, U.l1, "quarter", "2026-04-01", 30)).target_id;
    tR3a = (await setTarget(U.ad, U.r3a, "week", "2026-05-04", 5)).target_id;

    expect(await err(setTarget(U.m1, U.r3a, "month", "2026-05-01", 1))).toBe("42501:not_in_scope");
    expect(await err(setTarget(U.m1, U.m1, "month", "2026-05-01", 1))).toBe("42501:self_change");
    expect(await err(setTarget(U.l1, U.r1a, "month", "2026-05-01", 1))).toBe("42501:not_permitted");
    expect(await err(setTarget(U.ceo, U.r1a, "month", "2026-05-01", 1))).toBe("42501:not_permitted");
    expect(await err(setTarget(U.m1, "00000000-0000-0000-0000-00000000beef", "month", "2026-05-01", 1))).toBe("P0002:user_not_found");
    expect(await err(setTarget(U.m1, null as unknown as string, "month", "2026-05-01", 1))).toBe("P0002:user_not_found");
    expect(await err(db.app.query("SELECT * FROM authz.performance_target_set($1,'month','2026-05-01',1,NULL,NULL)", [U.r1a])))
      .toBe("42501:not_permitted"); // no user context
  });

  it("refuses misaligned periods, empty targets and out-of-range counts", async () => {
    expect(await err(setTarget(U.m1, U.r1b, "week", "2026-05-05", 1))).toMatch(/^23514:/);    // a Tuesday
    expect(await err(setTarget(U.m1, U.r1b, "month", "2026-05-02", 1))).toMatch(/^23514:/);
    expect(await err(setTarget(U.m1, U.r1b, "quarter", "2026-05-01", 1))).toMatch(/^23514:/);
    expect(await err(setTarget(U.m1, U.r1b, "month", "2026-05-01", null))).toMatch(/^23514:/);
    expect(await err(setTarget(U.m1, U.r1b, "month", "2026-05-01", -1))).toMatch(/^23514:/);
    expect(await err(setTarget(U.m1, U.r1b, "year", "2026-01-01", 1))).toMatch(/^23514:/);
  });

  it("server-managed columns: set_by is the latest actor, timestamps and keys are the server's", async () => {
    const { rows } = await db.admin.query(
      "SELECT user_id, set_by, period_end::text AS period_end, submissions, interviews, placements FROM eureka.performance_target WHERE id = $1", [tR1a]);
    expect(rows[0]).toEqual({ user_id: U.r1a, set_by: U.m1, period_end: "2026-06-01", submissions: 12, interviews: null, placements: 2 });
    await setTarget(U.ad, U.r1a, "month", "2026-05-01", 12, null, 2);
    expect((await db.admin.query("SELECT set_by FROM eureka.performance_target WHERE id = $1", [tR1a])).rows[0].set_by).toBe(U.ad);
    const ends = (await db.admin.query<{ k: string; e: string }>(
      "SELECT period_kind AS k, period_end::text AS e FROM eureka.performance_target WHERE id = ANY ($1) ORDER BY period_kind", [[tL1, tR3a]])).rows;
    expect(ends).toEqual([{ k: "quarter", e: "2026-07-01" }, { k: "week", e: "2026-05-11" }]);
  });

  it("only the definer functions write: the app has no write grant and the guard refuses other writers", async () => {
    expect(await err(asUser(db.app, U.m1, (c) => c.query(
      "INSERT INTO eureka.performance_target (user_id, period_kind, period_start, submissions, set_by) VALUES ($1,'month','2026-07-01',1,$2)",
      [U.r1a, U.m1])))).toMatch(/^42501:permission denied/);
    expect(await err(asUser(db.app, U.m1, (c) => c.query("UPDATE eureka.performance_target SET submissions = 0")))).toMatch(/^42501:/);
    expect(await err(asUser(db.app, U.m1, (c) => c.query("DELETE FROM eureka.performance_target")))).toMatch(/^42501:/);
    // Even the table owner's direct write is refused by the guard (rule 4/6).
    expect(await err(db.admin.query(
      "INSERT INTO eureka.performance_target (user_id, period_kind, period_start, submissions, set_by) VALUES ($1,'month','2026-07-01',1,$2)",
      [U.r1a, U.m1]))).toMatch(/^42501:performance targets are written/);
  });

  it("RLS: the person, their lead, manager, AD and the CEO see a target; other teams do not", async () => {
    expect(await visibleTargets(U.r1a)).toEqual([tR1a]);
    expect(await visibleTargets(U.r1b)).toEqual([]);
    expect(await visibleTargets(U.l1)).toEqual(sorted([tR1a, tL1]));
    expect(await visibleTargets(U.l3)).toEqual([tR3a]);
    expect(await visibleTargets(U.m1)).toEqual(sorted([tR1a, tL1]));
    expect(await visibleTargets(U.m2)).toEqual([tR3a]);
    expect(await visibleTargets(U.ad)).toEqual(sorted([tR1a, tL1, tR3a]));
    expect(await visibleTargets(U.ceo)).toEqual(sorted([tR1a, tL1, tR3a]));
    for (const u of [U.hr, U.acct, U.admin, U.coach, U.locA, U.locD]) expect(await visibleTargets(u)).toEqual([]);
  });

  it("the read policy evaluates the scope functions once per statement (InitPlan, rule 3)", async () => {
    const plan = await asUser(db.app, U.m1, async (c) =>
      (await c.query<{ "QUERY PLAN": string }>("EXPLAIN SELECT id FROM eureka.performance_target")).rows.map((r) => r["QUERY PLAN"]).join("\n"));
    expect(plan).toMatch(/InitPlan/);
    expect(plan).not.toMatch(/SubPlan/);
  });

  it("delete re-checks the manage scope", async () => {
    const t = (await setTarget(U.m1, U.r1b, "week", "2026-05-04", 3)).target_id;
    const del = (actor: string, id: string) => asUser(db.app, actor, (c) => c.query("SELECT authz.performance_target_delete($1)", [id]), true);
    expect(await err(del(U.l1, t))).toBe("42501:not_permitted");
    expect(await err(del(U.m2, t))).toBe("42501:not_in_scope");
    expect(await err(del(U.m1, "00000000-0000-0000-0000-00000000beef"))).toBe("P0002:target_not_found");
    expect(await err(del(U.m1, t))).toBe("ok");
    expect((await db.admin.query("SELECT 1 FROM eureka.performance_target WHERE id = $1", [t])).rowCount).toBe(0);
  });
});

describe("authz.set_designation (0111)", () => {
  const set = (actor: string, user: string, d: string | null) =>
    asUser(db.app, actor, (c) => c.query("SELECT authz.set_designation($1, $2)", [user, d]), true);
  const designation = async (user: string) =>
    (await db.admin.query<{ designation: string | null }>("SELECT designation FROM eureka.app_user WHERE id = $1", [user])).rows[0]!.designation;

  it("designation:change within the hierarchy; access:manage for anyone; never yourself", async () => {
    expect(await err(set(U.m1, U.r1a, "  Senior Recruiter "))).toBe("ok");
    expect(await designation(U.r1a)).toBe("Senior Recruiter");
    expect(await err(set(U.ad, U.m1, "Sales Manager II"))).toBe("ok");
    expect(await err(set(U.m1, U.r3a, "X"))).toBe("42501:not_in_scope");
    expect(await err(set(U.m1, U.m1, "X"))).toBe("42501:self_change");
    expect(await err(set(U.l1, U.r1a, "X"))).toBe("42501:not_permitted");
    expect(await err(set(U.ceo, U.r1a, "X"))).toBe("42501:not_permitted");
    expect(await err(set(U.admin, U.r3a, "Recruiter"))).toBe("ok");
    expect(await err(set(U.admin, U.admin, "X"))).toBe("42501:self_change");
    expect(await err(set(U.m1, "00000000-0000-0000-0000-00000000beef", "X"))).toBe("P0002:user_not_found");
    expect(await err(db.app.query("SELECT authz.set_designation($1, 'X')", [U.r1a]))).toBe("42501:not_permitted");
    // Empty clears; control characters and overlong values are refused.
    expect(await err(set(U.m1, U.r1a, "   "))).toBe("ok");
    expect(await designation(U.r1a)).toBeNull();
    expect(await err(set(U.m1, U.r1a, "Lead\u0007"))).toBe("23514:invalid_designation");
    expect(await err(set(U.m1, U.r1a, "x".repeat(121)))).toBe("23514:invalid_designation");
    expect(await designation(U.r3a)).toBe("Recruiter");
  });

  it("the app still cannot update app_user.designation directly", async () => {
    expect(await err(asUser(db.app, U.admin, (c) => c.query("UPDATE eureka.app_user SET designation = 'X' WHERE id = $1", [U.r1a]))))
      .toMatch(/^42501:permission denied/);
  });
});

describe("performance-below-target (0112)", () => {
  const events = async (targetIds: string[]) => (await db.admin.query<{ id: string; aggregate_id: string; payload: Record<string, unknown> }>(
    "SELECT id, aggregate_id, payload FROM eureka.outbox_event WHERE type = 'performance.below_target' AND aggregate_id = ANY ($1) ORDER BY created_at, id",
    [targetIds])).rows;
  const recipients = async (ev: string) => (await db.worker.query<{ recipient_id: string; reason: string }>(
    "SELECT recipient_id, reason FROM authz.notification_recipients($1) ORDER BY reason, recipient_id", [ev])).rows;

  it("runs for the New York day once 07:15 local has passed", async () => {
    const due = (iso: string) => performanceBelowTargetJob().dueKeys(new Date(iso), { pool: db.worker, log: silentLogger });
    expect(await due("2026-06-15T11:14:00Z")).toEqual(["2026-06-14"]);   // 07:14 EDT
    expect(await due("2026-06-15T11:15:00Z")).toEqual(["2026-06-15"]);
    expect(await due("2026-12-15T12:15:00Z")).toEqual(["2026-12-15"]);   // 07:15 EST
  });

  it("emits once per ended target that fell short, within the window, with ids, kind and counts only", async () => {
    // r1b: week of Mon 2026-06-01; 1 of 3 submissions (one more in the next week, one by another recruiter).
    await submit(U.r1b, "2026-06-02T15:00:00Z");
    await submit(U.r1b, "2026-06-08T05:00:00Z");   // 01:00 EDT on the 8th: next week in New York
    await submit(U.r1a, "2026-06-03T15:00:00Z");
    const short = (await setTarget(U.m1, U.r1b, "week", "2026-06-01", 3, 0)).target_id;
    // r1a: met (1 of 1) in the same week.
    const met = (await setTarget(U.m1, U.r1a, "week", "2026-06-01", 1)).target_id;
    // r2a: week of 2026-04-06, ended long before the window.
    const old = (await setTarget(U.m1, U.r2a, "week", "2026-04-06", 5)).target_id;
    // r2a: a month still running on the run day.
    const running = (await setTarget(U.m1, U.r2a, "month", "2026-06-01", 5)).target_id;
    const all = [short, met, old, running];

    const job = performanceBelowTargetJob();
    const runner = new JobRunner(db.worker, [job], silentLogger);
    expect(await runner.runOnce(job, "2026-06-07")).toBe("ran");          // the week has not ended
    expect(await events(all)).toEqual([]);
    expect(await runner.runOnce(job, "2026-06-08")).toBe("ran");
    let ev = await events(all);
    expect(ev.map((e) => [e.aggregate_id, e.payload])).toEqual([[short, {
      targetId: short, userId: U.r1b, periodKind: "week", periodStart: "2026-06-01",
      submissionsTarget: 3, submissionsActual: 1, interviewsTarget: 0, interviewsActual: 0,
    }]]);
    expect(await runner.runOnce(job, "2026-06-08")).toBe("done-before");
    expect(await runner.runOnce(job, "2026-06-12")).toBe("ran");          // exactly once per target
    ev = await events(all);
    expect(ev).toHaveLength(1);
    const detail = (await db.admin.query("SELECT detail FROM eureka.job_run WHERE job_name = $1 AND run_key = '2026-06-12'",
      [PERFORMANCE_BELOW_TARGET_JOB])).rows[0]!.detail;
    expect(detail).toEqual({ emitted: 0 });

    // Recipients: the person, their lead and the lead's manager.
    expect(await recipients(ev[0]!.id)).toEqual([
      { recipient_id: U.l1, reason: "lead" }, { recipient_id: U.m1, reason: "manager" }, { recipient_id: U.r1b, reason: "recruiter" }]);
  });

  it("refuses a future or missing day and a bad window", async () => {
    const run = (day: string | null, w: number | null) => db.worker.query("SELECT authz.emit_performance_below_target($1::date, $2::int)", [day, w]);
    expect(await err(run("2999-01-01", 14))).toMatch(/^23514:invalid performance-below-target run/);
    expect(await err(run(null, 14))).toMatch(/^23514:/);
    expect(await err(run("2026-06-01", null))).toMatch(/^23514:/);
    expect(await err(run("2026-06-01", 0))).toMatch(/^23514:/);
    expect(await err(run("2026-06-01", 400))).toMatch(/^23514:/);
  });

  it("the resolver: a lead's target goes to the lead and their manager; without a team, to the person's manager; forged payloads reach nobody", async () => {
    const lead = (await setTarget(U.m1, U.l1, "week", "2026-06-15", 9)).target_id;
    const mgr = (await setTarget(U.ad, U.m1, "week", "2026-06-15", 9)).target_id;
    const mk = (target: string, userId: string) => emitEvent(db, "performance.below_target", "performance_target", target,
      { targetId: target, userId, periodKind: "week", periodStart: "2026-06-15", submissionsTarget: 9, submissionsActual: 0 });
    expect(await recipients(await mk(lead, U.l1))).toEqual([
      { recipient_id: U.l1, reason: "lead" }, { recipient_id: U.m1, reason: "manager" }, { recipient_id: U.l1, reason: "recruiter" }]);
    expect(await recipients(await mk(mgr, U.m1))).toEqual([
      { recipient_id: U.ad, reason: "manager" }, { recipient_id: U.m1, reason: "recruiter" }]);
    // The payload names someone else than the target's person: no recipients (the event fails loudly).
    expect(await recipients(await mk(lead, U.r3a))).toEqual([]);
    expect(await recipients(await mk("00000000-0000-0000-0000-00000000beef", U.r1a))).toEqual([]);
  });

  it("delivers to the inbox with the target as the entity, naming nobody", async () => {
    const t = (await setTarget(U.m1, U.r1a, "month", "2026-03-01", 4, null, 1)).target_id;
    const ev = await emitEvent(db, "performance.below_target", "performance_target", t,
      { targetId: t, userId: U.r1a, periodKind: "month", periodStart: "2026-03-01",
        submissionsTarget: 4, submissionsActual: 2, placementsTarget: 1, placementsActual: 1 });
    await deliverEvent(db.worker, null, null, ev, workerCtx(), { mode: "inbox" });
    const rows = (await db.admin.query<{ recipient_id: string; entity_type: string; entity_id: string; title: string; body: string }>(
      "SELECT recipient_id, entity_type, entity_id, title, body FROM eureka.notification WHERE event_id = $1 ORDER BY recipient_id", [ev])).rows;
    expect(rows.map((r) => r.recipient_id)).toEqual(sorted([U.r1a, U.l1, U.m1]));
    for (const r of rows) {
      expect(r).toMatchObject({ entity_type: "performance_target", entity_id: t, title: "Activity below target for the month" });
      expect(r.body).toContain("submissions 2 of 4, placements 1 of 1");
      for (const s of ["r1a", "l1", "Team Rohit", "2026-03-01"]) expect(r.body).not.toContain(s);
    }
  });

  it("the template refuses payloads that are not below target or carry unmatched counts", () => {
    const base = { id: "x", type: "performance.below_target", aggregate_id: U.r1a };
    const p = { targetId: U.r1a, userId: U.r1a, periodKind: "week", periodStart: "2026-06-01" };
    const render = EVENT_SPECS["performance.below_target"]!.render;
    expect(() => render({ ...base, payload: { ...p, submissionsTarget: 1, submissionsActual: 1 } })).toThrow(/not below target/);
    expect(() => render({ ...base, payload: { ...p, submissionsActual: 1 } })).toThrow(/submissionsActual/);
    expect(() => render({ ...base, payload: { ...p, periodKind: "year", submissionsTarget: 2, submissionsActual: 1 } })).toThrow(/periodKind/);
    expect(render({ ...base, payload: { ...p, submissionsTarget: 2, submissionsActual: 1 } }).subject)
      .toBe("Eureka: recruiter activity below target for the week");
  });
});

describe("registry and hygiene", () => {
  it("every delivered type has a resolver branch and every in-app type an entity branch (a merged migration must carry them over)", async () => {
    const src = async (name: string) => (await db.admin.query<{ src: string }>(
      "SELECT prosrc AS src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'authz' AND p.proname = $1", [name])).rows[0]!.src;
    const recipientsSrc = await src("notification_recipients");
    const entitySrc = await src("notification_entity");
    for (const t of DELIVERED_TYPES) expect(recipientsSrc, t).toContain(`'${t}'`);
    for (const t of INBOX_TYPES) expect(entitySrc, t).toContain(`'${t}'`);
  });

  it("the inbox entity check keeps every earlier entity type and adds performance_target", async () => {
    const def = (await db.admin.query<{ d: string }>(
      "SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname = 'notification_entity_type_check'")).rows[0]!.d;
    for (const t of ["placement", "candidate", "application", "conversation", "interview", "digest", "performance_target"]) {
      expect(def).toContain(`'${t}'`);
    }
  });

  it("functions pin search_path, are not executable by PUBLIC and are granted to exactly the role that needs them", async () => {
    const { rows } = await db.admin.query<{ sig: string; owner: string; cfg: string[] | null; definer: boolean; pub: boolean; app: boolean; worker: boolean; owner_exec: boolean }>(`
      SELECT p.oid::regprocedure::text AS sig, pg_get_userbyid(p.proowner) AS owner, p.proconfig AS cfg, p.prosecdef AS definer,
             has_function_privilege('public', p.oid, 'EXECUTE') AS pub,
             has_function_privilege('eureka_app', p.oid, 'EXECUTE') AS app,
             has_function_privilege('eureka_worker', p.oid, 'EXECUTE') AS worker,
             has_function_privilege('eureka_owner', p.oid, 'EXECUTE') AS owner_exec
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'authz' AND p.proname IN ('scope_user_ids', 'performance_target_guard', 'performance_target_check',
         'performance_target_set', 'performance_target_delete', 'set_designation', 'emit_performance_below_target',
         'notification_recipients', 'notification_entity')
       ORDER BY 1`);
    const by = Object.fromEntries(rows.map((r) => [r.sig.replace(/\(.*$/, "").replace("authz.", ""), r]));
    expect(Object.keys(by).sort()).toEqual(["emit_performance_below_target", "notification_entity", "notification_recipients",
      "performance_target_check", "performance_target_delete", "performance_target_guard", "performance_target_set", "scope_user_ids", "set_designation"]);
    for (const r of rows) {
      expect(r.owner, r.sig).toBe("authz_definer");
      expect(r.cfg, r.sig).toEqual(["search_path=pg_catalog, pg_temp"]);
      expect(r.pub, r.sig).toBe(false);
    }
    const access = (k: string) => ({ app: by[k]!.app, worker: by[k]!.worker });
    for (const k of ["scope_user_ids", "performance_target_set", "performance_target_delete", "set_designation"]) {
      expect(access(k), k).toEqual({ app: true, worker: false });
      expect(by[k]!.definer, k).toBe(true);
    }
    for (const k of ["emit_performance_below_target", "notification_recipients", "notification_entity"]) {
      expect(access(k), k).toEqual({ app: false, worker: true });
    }
    expect(access("performance_target_check")).toEqual({ app: false, worker: false });
    expect(by.performance_target_check!.definer).toBe(false);
    expect(access("performance_target_guard")).toEqual({ app: false, worker: false });
    expect(by.performance_target_guard!.owner_exec).toBe(true);
  });

  it("the target table forces RLS and the app holds SELECT only", async () => {
    const { rows } = await db.admin.query(`SELECT relrowsecurity r, relforcerowsecurity f FROM pg_class WHERE oid = 'eureka.performance_target'::regclass`);
    expect(rows[0]).toEqual({ r: true, f: true });
    const priv = (await db.admin.query<{ p: string }>(
      `SELECT privilege_type AS p FROM information_schema.role_table_grants WHERE grantee = 'eureka_app' AND table_name = 'performance_target' ORDER BY 1`)).rows;
    expect(priv.map((r) => r.p)).toEqual(["SELECT"]);
    const worker = (await db.admin.query(
      `SELECT 1 FROM information_schema.role_table_grants WHERE grantee = 'eureka_worker' AND table_name = 'performance_target'`)).rowCount;
    expect(worker).toBe(0);
  });
});

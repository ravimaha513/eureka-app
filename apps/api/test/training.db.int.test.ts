import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { trainingBatchCovered, trainingCandidateCovered } from "@eureka/shared";
import { asUser, createTestDb, ownedCandidateCalls, type TestDb } from "./db-harness.js";
import { LOC, T, TECH_ID, U, seedFixtures, toUserAccess, type FixtureCandidate } from "./fixtures.js";

/** Database rules of migration 0065 (docs/training-api.md): RLS, guards and definer functions, run directly as eureka_app. */
let db: TestDb;
let candidates: FixtureCandidate[];
const users = Object.keys(U) as (keyof typeof U)[];

const q = <T = Record<string, unknown>>(user: string, sql: string, params: unknown[] = []) =>
  asUser(db.app, user, async (c) => (await c.query(sql, params)).rows as T[], true);

let course: string; let moduleA: string; let moduleB: string; let otherCourse: string; let otherModule: string;
let batch: string;
let s1: FixtureCandidate; let s2: FixtureCandidate; let austin: FixtureCandidate; let outsider: FixtureCandidate;

beforeAll(async () => {
  db = await createTestDb();
  candidates = await seedFixtures(db.admin);
  // Dallas students: one of r1a (Team Rohit), one of Team Anjali (coached by `coach`).
  s1 = candidates.find((c) => c.recruiterId === U.r1a && c.locationId === LOC.dallas)!;
  s2 = candidates.find((c) => c.teamId === T.t2 && c.locationId === LOC.dallas)!;
  outsider = candidates.find((c) => c.teamId === T.t3 && c.locationId === LOC.dallas)!;
  austin = candidates.find((c) => c.locationId === LOC.austin)!;
}, 120_000);

afterAll(async () => { await db?.drop(); });

describe("course catalog (TR-4)", () => {
  it("a training manager writes courses of their location; the server stamps who, when and the version", async () => {
    const [row] = await q<{ id: string; created_by: string; row_version: number }>(U.locD,
      `INSERT INTO eureka.course (location_id, title, description) VALUES ($1, 'Full Stack Basics', 'Line one\nLine two')
       RETURNING id, created_by, row_version`, [LOC.dallas]);
    course = row!.id;
    expect(row).toMatchObject({ created_by: U.locD, row_version: 1 });
    const mods = await q<{ id: string }>(U.locD,
      `INSERT INTO eureka.course_module (course_id, position, title, duration_minutes, resource_urls)
       VALUES ($1, 1, 'HTML', 60, ARRAY['https://example.com/html']), ($1, 2, 'CSS', 180, '{}') RETURNING id`, [course]);
    [moduleA, moduleB] = mods.map((m) => m.id) as [string, string];
    otherCourse = (await q<{ id: string }>(U.locD, `INSERT INTO eureka.course (location_id, title) VALUES ($1, 'Git') RETURNING id`, [LOC.dallas]))[0]!.id;
    otherModule = (await q<{ id: string }>(U.locD,
      `INSERT INTO eureka.course_module (course_id, position, title, duration_minutes) VALUES ($1, 1, 'Branches', 30) RETURNING id`, [otherCourse]))[0]!.id;
    const [upd] = await q<{ row_version: number }>(U.locD, `UPDATE eureka.course SET title = 'Full Stack' WHERE id = $1 RETURNING row_version`, [course]);
    expect(upd!.row_version).toBe(2);
  });

  it("refuses another location, roles without training:manage, and client-set server columns", async () => {
    await expect(q(U.locD, `INSERT INTO eureka.course (location_id, title) VALUES ($1, 'X')`, [LOC.austin])).rejects.toThrow(/row-level security/);
    await expect(q(U.coach, `INSERT INTO eureka.course (location_id, title) VALUES ($1, 'X')`, [LOC.dallas])).rejects.toThrow(/row-level security/);
    await expect(q(U.l1, `INSERT INTO eureka.course (location_id, title) VALUES ($1, 'X')`, [LOC.dallas])).rejects.toThrow(/row-level security/);
    await expect(q(U.locD, `INSERT INTO eureka.course (location_id, title, created_by) VALUES ($1, 'X', $2)`, [LOC.dallas, U.l1])).rejects.toThrow(/permission denied/);
    await expect(q(U.locD, `UPDATE eureka.course SET row_version = 9 WHERE id = $1`, [course])).rejects.toThrow(/permission denied/);
    // Another location's manager neither updates nor deletes it (USING filters the row out).
    expect(await q(U.locA, `UPDATE eureka.course SET title = 'Hijack' WHERE id = $1 RETURNING id`, [course])).toEqual([]);
    expect(await q(U.locA, `DELETE FROM eureka.course_module WHERE course_id = $1 RETURNING id`, [course])).toEqual([]);
    await expect(q(U.locA, `INSERT INTO eureka.course_module (course_id, position, title, duration_minutes) VALUES ($1, 9, 'X', 5)`, [course]))
      .rejects.toThrow(/row-level security/);
  });

  it("validates titles, durations and https resource links", async () => {
    const add = (urls: string[]) => q(U.locD,
      `INSERT INTO eureka.course_module (course_id, position, title, duration_minutes, resource_urls) VALUES ($1, 50, 'R', 5, $2)`, [course, urls]);
    for (const bad of [["http://example.com"], ["javascript:alert(1)"], ["https://exa mple.com"], ["https://a\nhttps://b"],
      ["https://user@example.com/x"], ["https://user:pw@example.com"], ["https://@example.com"], ["https://example.com@evil.example"]]) {
      await expect(add(bad)).rejects.toThrow(/check constraint/);
    }
    // '@' after the authority (path, query) is fine.
    await add(["https://example.com/a@b", "https://example.com?u=a@b"]);
    await expect(add(Array.from({ length: 11 }, (_, i) => `https://e.com/${i}`))).rejects.toThrow(/check constraint/);
    await expect(q(U.locD, `INSERT INTO eureka.course_module (course_id, position, title, duration_minutes) VALUES ($1, 51, 'Z', 0)`, [course]))
      .rejects.toThrow(/check constraint/);
    await expect(q(U.locD, `INSERT INTO eureka.course (location_id, title) VALUES ($1, E'Bad\\x07')`, [LOC.dallas])).rejects.toThrow(/check constraint/);
  });

  it("is readable by every training:read holder and nobody else", async () => {
    for (const key of users) {
      const rows = await q(U[key], `SELECT id FROM eureka.course WHERE id = $1`, [course]);
      expect(rows.length, key).toBe(toUserAccess(key).roles.some((r) =>
        ["recruiter", "lead", "manager", "assoc_director", "offshore_manager", "ceo", "location_incharge", "location_ops_admin", "interview_coach"].includes(r.role)) ? 1 : 0);
    }
  });
});

describe("batches (TR-5..TR-7)", () => {
  it("training managers create batches at their location only; coaches never", async () => {
    batch = (await q<{ id: string }>(U.locD, `SELECT authz.create_batch($1, $2, '2031-03-01', 20) AS id`, [LOC.dallas, TECH_ID]))[0]!.id;
    await expect(q(U.locD, `SELECT authz.create_batch($1, $2, '2031-04-01', 20)`, [LOC.austin, TECH_ID])).rejects.toThrow(/location_not_in_scope/);
    await expect(q(U.coach, `SELECT authz.create_batch($1, $2, '2031-04-01', 20)`, [LOC.dallas, TECH_ID])).rejects.toThrow(/not_permitted/);
    const [b] = await q<{ status: string; created_by: string; row_version: number }>(U.locD, `SELECT status, created_by, row_version FROM eureka.batch WHERE id = $1`, [batch]);
    expect(b).toEqual({ status: "planned", created_by: U.locD, row_version: 1 });
  });

  it("update_batch checks the version, the trainer, the dates and the manager", async () => {
    const upd = (user: string, v: number, trainer: string | null, start = "2031-03-02", end: string | null = "2031-09-30") =>
      q<{ v: number }>(user, `SELECT authz.update_batch($1, $2, '.NET 2031', $3, $4::date, $5::date, 20, 'teal', 'code') AS v`, [batch, v, trainer, start, end]);
    await expect(upd(U.locD, 7, U.coach)).rejects.toThrow(/stale/);
    await expect(upd(U.locD, 1, U.r1a)).rejects.toThrow(/invalid_trainer/);
    await expect(upd(U.locD, 1, U.coach, "2031-03-02", "2031-03-01")).rejects.toThrow(/invalid_dates/);
    await expect(upd(U.locA, 1, U.coach)).rejects.toThrow(/not_permitted/);
    // Sales planning rights (batch_manager) reach create and status only, never the details (TR-1).
    await expect(upd(U.l1, 1, U.coach)).rejects.toThrow(/not_permitted/);
    await expect(upd(U.m1, 1, U.coach)).rejects.toThrow(/not_permitted/);
    await expect(upd(U.coach, 1, U.coach)).rejects.toThrow(/not_permitted/);
    expect((await upd(U.locD, 1, U.coach))[0]!.v).toBe(2);
    const [b] = await q(U.locD, `SELECT name, trainer_id, start_date::text, start_month::text, end_date::text, cover_color, cover_icon FROM eureka.batch WHERE id = $1`, [batch]);
    expect(b).toEqual({ name: ".NET 2031", trainer_id: U.coach, start_date: "2031-03-02", start_month: "2031-03-01", end_date: "2031-09-30", cover_color: "teal", cover_icon: "code" });
    // The app still cannot write batches directly.
    await expect(q(U.locD, `UPDATE eureka.batch SET name = 'x' WHERE id = $1`, [batch])).rejects.toThrow(/permission denied/);
  });

  it.each(users)("authz.training_batch_ids for %s matches the engine (trainingBatchCovered)", async (key) => {
    for (const perm of ["training:read", "training:manage", "training.progress:update"] as const) {
      const [r] = await q<{ ok: boolean }>(U[key], `SELECT coalesce($1 = ANY (authz.training_batch_ids($2)), false) AS ok`, [batch, perm]);
      expect(r!.ok, perm).toBe(trainingBatchCovered(toUserAccess(key), perm, { locationId: LOC.dallas, trainerId: U.coach }));
    }
  });

  it("courses of a batch: written by its training managers only, open batches and active courses only", async () => {
    await q(U.locD, `INSERT INTO eureka.batch_course (batch_id, course_id, position) VALUES ($1, $2, 1)`, [batch, course]);
    await expect(q(U.coach, `INSERT INTO eureka.batch_course (batch_id, course_id, position) VALUES ($1, $2, 2)`, [batch, otherCourse])).rejects.toThrow(/row-level security/);
    await expect(q(U.locA, `INSERT INTO eureka.batch_course (batch_id, course_id, position) VALUES ($1, $2, 2)`, [batch, otherCourse])).rejects.toThrow(/row-level security/);
    await expect(q(U.locD, `INSERT INTO eureka.batch_course (batch_id, course_id, position, added_by) VALUES ($1, $2, 2, $3)`, [batch, otherCourse, U.l1])).rejects.toThrow(/permission denied/);
    const [bc] = await q(U.coach, `SELECT added_by FROM eureka.batch_course WHERE batch_id = $1`, [batch]);
    expect(bc).toEqual({ added_by: U.locD });
    await q(U.locD, `UPDATE eureka.course SET archived = true WHERE id = $1`, [otherCourse]);
    await expect(q(U.locD, `INSERT INTO eureka.batch_course (batch_id, course_id, position) VALUES ($1, $2, 2)`, [batch, otherCourse])).rejects.toThrow(/course_archived/);
    await q(U.locD, `UPDATE eureka.course SET archived = false WHERE id = $1`, [otherCourse]);
  });
});

describe("students and progress (TR-8..TR-10)", () => {
  it("a training manager adds students of the batch location; others cannot", async () => {
    await q(U.locD, `SELECT authz.set_batch_student($1, $2, true)`, [batch, s1.id]);
    await q(U.locD, `SELECT authz.set_batch_student($1, $2, true)`, [batch, s2.id]);
    await expect(q(U.locD, `SELECT authz.set_batch_student($1, $2, true)`, [batch, austin.id])).rejects.toThrow(/candidate_not_eligible/);
    await expect(q(U.locD, `SELECT authz.set_batch_student($1, gen_random_uuid(), true)`, [batch])).rejects.toThrow(/candidate_not_eligible/);
    await expect(q(U.coach, `SELECT authz.set_batch_student($1, $2, true)`, [batch, outsider.id])).rejects.toThrow(/not_permitted/);
    await expect(q(U.locA, `SELECT authz.set_batch_student($1, $2, true)`, [batch, outsider.id])).rejects.toThrow(/batch_not_found/);
    await expect(q(U.l1, `SELECT authz.set_batch_student($1, $2, true)`, [batch, s1.id])).rejects.toThrow(/batch_not_found/);
    await expect(q(U.locD, `SELECT authz.set_batch_student($1, $2, false)`, [batch, outsider.id])).rejects.toThrow(/not_in_batch/);
    // Location roles hold no candidate:update: a direct edit stays refused by the column guard.
    await expect(q(U.locD, `UPDATE eureka.candidate SET batch_id = $1 WHERE id = $2`, [batch, outsider.id])).rejects.toThrow(/not permitted to update profile fields/);
    // The timeline records the change with the manager as actor.
    const [ev] = await db.admin.query(`SELECT actor_id, ref_id FROM eureka.candidate_event WHERE candidate_id = $1 AND type = 'candidate.batch_changed'`, [s1.id])
      .then((r) => r.rows);
    expect(ev).toEqual({ actor_id: U.locD, ref_id: batch });
  });

  it("the trainer and location roles mark modules of assigned courses for current students", async () => {
    const [t] = await q<{ t: Date }>(U.coach, `SELECT authz.set_module_progress($1, $2, $3, true) AS t`, [batch, s1.id, moduleA]);
    expect(t!.t).toBeInstanceOf(Date);
    await q(U.locD, `SELECT authz.set_module_progress($1, $2, $3, true)`, [batch, s2.id, moduleB]);
    await expect(q(U.coach, `SELECT authz.set_module_progress($1, $2, $3, true)`, [batch, s1.id, otherModule])).rejects.toThrow(/module_not_in_batch/);
    await expect(q(U.coach, `SELECT authz.set_module_progress($1, $2, $3, true)`, [batch, outsider.id, moduleA])).rejects.toThrow(/not_in_batch/);
    await expect(q(U.locA, `SELECT authz.set_module_progress($1, $2, $3, true)`, [batch, s1.id, moduleA])).rejects.toThrow(/batch_not_found/);
    await expect(q(U.r1a, `SELECT authz.set_module_progress($1, $2, $3, true)`, [batch, s1.id, moduleA])).rejects.toThrow(/batch_not_found/);
    await expect(q(U.locD, `INSERT INTO eureka.module_progress (batch_id, candidate_id, module_id, completed_by) VALUES ($1, $2, $3, $4)`,
      [batch, s1.id, moduleB, U.locD])).rejects.toThrow(/permission denied/);
    await expect(q(U.locD, `DELETE FROM eureka.module_progress`)).rejects.toThrow(/permission denied/);
    const [row] = await q(U.locD, `SELECT completed_by FROM eureka.module_progress WHERE candidate_id = $1`, [s1.id]);
    expect(row).toEqual({ completed_by: U.coach });
    // Idempotent; clearing removes the row.
    await q(U.coach, `SELECT authz.set_module_progress($1, $2, $3, true)`, [batch, s1.id, moduleA]);
    await q(U.coach, `SELECT authz.set_module_progress($1, $2, $3, false)`, [batch, s2.id, moduleB]);
    expect(await q(U.locD, `SELECT 1 FROM eureka.module_progress WHERE candidate_id = $1`, [s2.id])).toEqual([]);
    await q(U.coach, `SELECT authz.set_module_progress($1, $2, $3, true)`, [batch, s2.id, moduleB]);
  });

  it.each(users)("progress rows readable by %s match batch-level or candidate-level coverage", async (key) => {
    const rows = (await q<{ candidate_id: string }>(U[key], `SELECT candidate_id FROM eureka.module_progress WHERE batch_id = $1`, [batch]))
      .map((r) => r.candidate_id).sort();
    const access = toUserAccess(key);
    const batchLevel = trainingBatchCovered(access, "training:read", { locationId: LOC.dallas, trainerId: U.coach });
    const expected = [s1, s2].filter((s) => batchLevel || trainingCandidateCovered(access, s)).map((s) => s.id).sort();
    expect(rows).toEqual(expected);
  });

  it.each(users)("training_batch_students and training_batches for %s list the same students", async (key) => {
    const access = toUserAccess(key);
    const batchLevel = trainingBatchCovered(access, "training:read", { locationId: LOC.dallas, trainerId: U.coach });
    const expected = [s1, s2].filter((s) => batchLevel || trainingCandidateCovered(access, s)).map((s) => s.id).sort();
    const listed = (await q<{ candidate_id: string }>(U[key], `SELECT candidate_id FROM authz.training_batch_students($1)`, [batch]))
      .map((r) => r.candidate_id).sort();
    expect(listed).toEqual(expected);
    const [b] = await q<{ covered: boolean; students: number }>(U[key], `SELECT covered, students FROM authz.training_batches() WHERE batch_id = $1`, [batch]);
    if (expected.length === 0) expect(b).toBeUndefined();
    else expect(b).toEqual({ covered: batchLevel, students: expected.length });
  });

  it("the progress read policy resolves the owned-candidate set once per statement (rule 3)", async () => {
    const r = await ownedCandidateCalls(db.admin, U.m1, `SELECT * FROM eureka.module_progress`);
    expect(r.calls).toBeLessThanOrEqual(1);
    expect(r.rows).toBe(2); // m1's hierarchy owns both students
  });

  it("no user context: nothing visible, nothing written", async () => {
    expect((await db.app.query(`SELECT * FROM eureka.module_progress`)).rows).toEqual([]);
    expect((await db.app.query(`SELECT * FROM eureka.course`)).rows).toEqual([]);
    expect((await db.app.query(`SELECT * FROM authz.training_batches()`)).rows).toEqual([]);
    await expect(db.app.query(`SELECT authz.set_module_progress($1, $2, $3, true)`, [batch, s1.id, moduleA])).rejects.toThrow(/batch_not_found/);
  });
});

describe("set_batch_student needs a readable candidate (TR-8)", () => {
  it("refuses a candidate the caller cannot read, with the same answer as an ineligible one", async () => {
    await db.admin.query(`DELETE FROM eureka.role_permission WHERE role_key = 'location_ops_admin' AND permission = 'candidate:read'`);
    try {
      await expect(q(U.locD, `SELECT authz.set_batch_student($1, $2, true)`, [batch, outsider.id])).rejects.toThrow(/candidate_not_eligible/);
    } finally {
      await db.admin.query(`INSERT INTO eureka.role_permission (role_key, permission, scope) VALUES ('location_ops_admin', 'candidate:read', 'location')`);
    }
    await q(U.locD, `SELECT authz.set_batch_student($1, $2, true)`, [batch, outsider.id]);
    await q(U.locD, `SELECT authz.set_batch_student($1, $2, false)`, [batch, outsider.id]);
  });
});

describe("a course used by another location's batch is frozen for its owner (TR-4)", () => {
  let shared: string; let m1: string; let m2: string; let austinBatch: string;
  it("the owner can still retitle and add links; durations, order, deletes, adds and archiving are refused (409 course_shared)", async () => {
    shared = (await q<{ id: string }>(U.locD, `INSERT INTO eureka.course (location_id, title) VALUES ($1, 'Shared') RETURNING id`, [LOC.dallas]))[0]!.id;
    [m1, m2] = (await q<{ id: string }>(U.locD,
      `INSERT INTO eureka.course_module (course_id, position, title, duration_minutes) VALUES ($1, 1, 'A', 30), ($1, 2, 'B', 30) RETURNING id`, [shared])).map((r) => r.id) as [string, string];
    // Used only by a Dallas batch: still editable by Dallas.
    await q(U.locD, `INSERT INTO eureka.batch_course (batch_id, course_id, position) VALUES ($1, $2, 3)`, [batch, shared]);
    await q(U.locD, `UPDATE eureka.course_module SET duration_minutes = 45 WHERE id = $1`, [m1]);
    // An Austin batch picks it up.
    austinBatch = (await q<{ id: string }>(U.locA, `SELECT authz.create_batch($1, $2, '2031-05-01', 5) AS id`, [LOC.austin, TECH_ID]))[0]!.id;
    await q(U.locA, `INSERT INTO eureka.batch_course (batch_id, course_id, position) VALUES ($1, $2, 1)`, [austinBatch, shared]);
    const refused = (sql: string, params: unknown[] = []) => expect(q(U.locD, sql, params)).rejects.toThrow(/course_shared/);
    await refused(`UPDATE eureka.course_module SET duration_minutes = 99 WHERE id = $1`, [m1]);
    await refused(`UPDATE eureka.course_module SET position = 5 WHERE id = $1`, [m1]);
    await refused(`DELETE FROM eureka.course_module WHERE id = $1`, [m2]);
    await refused(`INSERT INTO eureka.course_module (course_id, position, title, duration_minutes) VALUES ($1, 3, 'C', 10)`, [shared]);
    await refused(`UPDATE eureka.course SET archived = true WHERE id = $1`, [shared]);
    expect(await q(U.locD, `UPDATE eureka.course_module SET title = 'A2', resource_urls = ARRAY['https://example.com/x'] WHERE id = $1 RETURNING id`, [m1])).toHaveLength(1);
    expect(await q(U.locD, `UPDATE eureka.course SET title = 'Shared 2', description = 'd' WHERE id = $1 RETURNING id`, [shared])).toHaveLength(1);
    // The same duration value (no change) is not an edit.
    expect(await q(U.locD, `UPDATE eureka.course_module SET duration_minutes = 45 WHERE id = $1 RETURNING id`, [m1])).toHaveLength(1);
  });

  it("a deleted course's modules (cascade) and unused courses stay freely editable", async () => {
    const [c] = await q<{ id: string }>(U.locD, `INSERT INTO eureka.course (location_id, title) VALUES ($1, 'Unused') RETURNING id`, [LOC.dallas]);
    await q(U.locD, `INSERT INTO eureka.course_module (course_id, position, title, duration_minutes) VALUES ($1, 1, 'X', 10)`, [c!.id]);
    await q(U.locD, `UPDATE eureka.course SET archived = true WHERE id = $1`, [c!.id]);
    await q(U.locD, `DELETE FROM eureka.course WHERE id = $1`, [c!.id]);
  });
});

describe("deleting (TR-7, TR-4)", () => {
  it("a module or course with completions is kept (foreign key)", async () => {
    await expect(q(U.locD, `DELETE FROM eureka.course_module WHERE id = $1`, [moduleA])).rejects.toThrow(/foreign key/);
    await expect(q(U.locD, `DELETE FROM eureka.course WHERE id = $1`, [course])).rejects.toThrow(/foreign key/);
  });

  it("a batch with students cannot be deleted; without them it goes with its courses and progress", async () => {
    await expect(q(U.locD, `SELECT authz.delete_batch($1)`, [batch])).rejects.toThrow(/batch_has_students/);
    await expect(q(U.coach, `SELECT authz.delete_batch($1)`, [batch])).rejects.toThrow(/not_permitted/);
    await expect(q(U.l1, `SELECT authz.delete_batch($1)`, [batch])).rejects.toThrow(/not_permitted/);
    await expect(q(U.m1, `SELECT authz.delete_batch($1)`, [batch])).rejects.toThrow(/not_permitted/);
    await q(U.locD, `SELECT authz.set_batch_student($1, $2, false)`, [batch, s1.id]);
    await q(U.locD, `SELECT authz.set_batch_student($1, $2, false)`, [batch, s2.id]);
    await q(U.locD, `SELECT authz.delete_batch($1)`, [batch]);
    const left = await db.admin.query(`SELECT (SELECT count(*) FROM eureka.batch WHERE id = $1)::int AS b,
      (SELECT count(*) FROM eureka.batch_course WHERE batch_id = $1)::int AS bc, (SELECT count(*) FROM eureka.module_progress WHERE batch_id = $1)::int AS mp`, [batch]);
    expect(left.rows[0]).toEqual({ b: 0, bc: 0, mp: 0 });
    // Now unused, the course can be deleted with its modules.
    await q(U.locD, `DELETE FROM eureka.course WHERE id = $1`, [course]);
  });
});

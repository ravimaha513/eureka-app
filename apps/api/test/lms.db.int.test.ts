import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asUser, createTestDb, type TestDb } from "./db-harness.js";
import { U, seedFixtures } from "./fixtures.js";
import { lmsCall, newBatch, newCourse } from "./lms-seed.js";

/** Database-only checks for migration 0082 (LMS): every rule holds with the API removed (design B8). */
let db: TestDb;
let batch1: string;
let batch2: string;
let c1: { id: string; moduleIds: string[] };
let inactive: string;

beforeAll(async () => {
  db = await createTestDb();
  await seedFixtures(db.admin);
  inactive = (await db.admin.query<{ id: string }>(
    `INSERT INTO eureka.app_user (email, display_name, status) VALUES ('gone@eureka.example', 'gone', 'inactive') RETURNING id`)).rows[0]!.id;
  c1 = await newCourse(db, U.hr, "Java basics", [{ title: "Syntax", durationMinutes: 60 }, { title: "OOP", durationMinutes: 180 }]);
  batch1 = await newBatch(db, U.hr, "Batch A");
  batch2 = await newBatch(db, U.coach, "Batch B");
  for (const b of [batch1, batch2]) await lmsCall(db, U.hr, `SELECT authz.lms_set_batch_courses($1, $2::uuid[])`, [b, [c1.id]]);
  await lmsCall(db, U.hr, `SELECT authz.lms_add_students($1, $2::uuid[])`, [batch1, [U.r1a]]);
  await lmsCall(db, U.hr, `SELECT authz.lms_add_students($1, $2::uuid[])`, [batch2, [U.r1b]]);
  await lmsCall(db, U.r1a, `SELECT * FROM authz.lms_set_my_progress($1, $2, 50)`, [batch1, c1.moduleIds[0]]);
  await lmsCall(db, U.r1b, `SELECT * FROM authz.lms_set_my_progress($1, $2, 80)`, [batch2, c1.moduleIds[1]]);
}, 120_000);

afterAll(async () => {
  await db?.drop();
});

const as = <R = Record<string, any>>(user: string, sql: string, params: unknown[] = []) =>
  asUser(db.app, user, async (c) => (await c.query(sql, params)).rows as R[]);

describe("catalog grants", () => {
  it("lms:manage at org for hr, associate_hr, interview_coach; lms:learn at own for everyone but org_admin", async () => {
    const r = await db.admin.query<{ role_key: string; permission: string; scope: string }>(
      `SELECT role_key, permission, scope FROM eureka.role_permission WHERE permission LIKE 'lms:%'`);
    const manage = r.rows.filter((x) => x.permission === "lms:manage");
    expect(manage.map((x) => x.role_key).sort()).toEqual(["associate_hr", "hr", "interview_coach"]);
    expect(manage.every((x) => x.scope === "org")).toBe(true);
    const learn = r.rows.filter((x) => x.permission === "lms:learn");
    expect(learn).toHaveLength(15);
    expect(learn.every((x) => x.scope === "own")).toBe(true);
    expect(learn.some((x) => x.role_key === "org_admin")).toBe(false);
  });
});

describe("app role cannot write directly", () => {
  it.each([
    [`INSERT INTO eureka.lms_course (title, created_by) VALUES ('x', $1)`],
    [`UPDATE eureka.lms_batch SET name = 'x'`],
    [`DELETE FROM eureka.lms_enrollment`],
    [`INSERT INTO eureka.lms_module_progress (batch_id, user_id, module_id, percent) VALUES (gen_random_uuid(), $1, gen_random_uuid(), 5)`],
  ])("%s", async (sql) => {
    await expect(as(U.hr, sql, sql.includes("$1") ? [U.hr] : [])).rejects.toMatchObject({ code: "42501" });
  });

  it("not even the superuser writes outside the functions, and TRUNCATE is refused", async () => {
    await expect(db.admin.query(`UPDATE eureka.lms_course SET title = 'hacked'`)).rejects.toThrow(/only through lms functions/);
    await expect(db.admin.query(`DELETE FROM eureka.lms_module_progress`)).rejects.toThrow(/only through lms functions/);
    await expect(db.admin.query(`TRUNCATE eureka.lms_course CASCADE`)).rejects.toThrow(/never truncated/);
  });
});

describe("permission re-check in the definer functions", () => {
  const manage = [
    [`SELECT authz.lms_create_course('x', '')`],
    [`SELECT authz.lms_create_batch('x', '2026-01-01', '2026-02-01', NULL)`],
    [`SELECT authz.lms_update_batch($1, '{"name":"y"}')`, "batch"],
    [`SELECT authz.lms_delete_batch($1)`, "batch"],
    [`SELECT authz.lms_set_batch_courses($1, '{}')`, "batch"],
    [`SELECT authz.lms_add_students($1, '{}')`, "batch"],
    [`SELECT authz.lms_remove_student($1, $2)`, "batch", "user"],
    [`SELECT * FROM authz.lms_set_progress($1, $2, $3, 10)`, "batch", "user", "module"],
  ] as const;
  it.each(manage)("%s refuses a learner and an org admin", async (sql, ...args) => {
    const p = args.map((a) => (a === "batch" ? batch1 : a === "user" ? U.r1a : c1.moduleIds[0]));
    for (const who of [U.r1a, U.ceo, U.admin]) await expect(as(who, sql, p)).rejects.toMatchObject({ message: "not_permitted" });
  });

  it("module and course writes refuse a learner", async () => {
    await expect(as(U.r1a, `SELECT authz.lms_update_course($1, NULL, '{"title":"x"}')`, [c1.id])).rejects.toMatchObject({ message: "not_permitted" });
    await expect(as(U.r1a, `SELECT authz.lms_set_modules($1, '[]', NULL)`, [c1.id])).rejects.toMatchObject({ message: "not_permitted" });
  });

  it("no user context: refused", async () => {
    await expect(db.app.query(`SELECT authz.lms_create_course('x', '')`)).rejects.toMatchObject({ message: "not_permitted" });
  });

  it("a user without lms:learn (org admin) cannot set own progress; an enrolled admin still cannot", async () => {
    await lmsCall(db, U.hr, `SELECT authz.lms_add_students($1, $2::uuid[])`, [batch1, [U.admin]]);
    await expect(as(U.admin, `SELECT * FROM authz.lms_set_my_progress($1, $2, 10)`, [batch1, c1.moduleIds[0]])).rejects.toMatchObject({ message: "not_permitted" });
    expect(await as(U.admin, `SELECT * FROM eureka.lms_enrollment`)).toHaveLength(0);
    await lmsCall(db, U.hr, `SELECT authz.lms_remove_student($1, $2)`, [batch1, U.admin]);
  });

  it("a learner cannot write progress in a batch they are not enrolled in (404) nor for another student", async () => {
    await expect(as(U.r1a, `SELECT * FROM authz.lms_set_my_progress($1, $2, 10)`, [batch2, c1.moduleIds[0]])).rejects.toMatchObject({ message: "not_found", code: "P0002" });
    // the function has no user parameter: r1a writing "for r1b" is impossible, r1b's row stays at 80
    const row = await db.admin.query(`SELECT percent FROM eureka.lms_module_progress WHERE user_id = $1`, [U.r1b]);
    expect(row.rows).toEqual([{ percent: 80 }]);
  });
});

describe("RLS reads", () => {
  it("a learner sees only their own batch, enrollment, courses, modules and progress", async () => {
    expect((await as<{ id: string }>(U.r1a, `SELECT id FROM eureka.lms_batch`)).map((r) => r.id)).toEqual([batch1]);
    expect(await as(U.r1a, `SELECT user_id FROM eureka.lms_enrollment`)).toEqual([{ user_id: U.r1a }]);
    expect(await as(U.r1a, `SELECT user_id, percent FROM eureka.lms_module_progress`)).toEqual([{ user_id: U.r1a, percent: 50 }]);
    expect(await as(U.r1a, `SELECT id FROM eureka.lms_course`)).toHaveLength(1);
    expect(await as(U.r1a, `SELECT id FROM eureka.lms_module`)).toHaveLength(2);
    expect(await as(U.r1a, `SELECT * FROM eureka.lms_batch WHERE id = $1`, [batch2])).toHaveLength(0);
  });

  it("a learner with nothing enrolled sees nothing; a course in no batch is invisible to learners", async () => {
    const orphan = await newCourse(db, U.hr, "Orphan", [{ title: "m", durationMinutes: 5 }]);
    expect(await as(U.r2a, `SELECT id FROM eureka.lms_course`)).toHaveLength(0);
    expect((await as(U.r1a, `SELECT id FROM eureka.lms_course WHERE id = $1`, [orphan.id]))).toHaveLength(0);
    expect(await as(U.r1a, `SELECT id FROM eureka.lms_module WHERE course_id = $1`, [orphan.id])).toHaveLength(0);
  });

  it("staff (hr, coach) see every batch and every progress row; other roles never do", async () => {
    for (const who of [U.hr, U.coach]) {
      expect(await as(who, `SELECT id FROM eureka.lms_batch`)).toHaveLength(2);
      expect(await as(who, `SELECT user_id FROM eureka.lms_module_progress`)).toHaveLength(2);
    }
    expect(await as(U.admin, `SELECT id FROM eureka.lms_batch`)).toHaveLength(0);
    expect(await as(U.ceo, `SELECT user_id FROM eureka.lms_enrollment`)).toHaveLength(0);
  });
});

describe("progress rules", () => {
  it("100 stamps completed_at, lowering clears it, repeated 100 keeps the first stamp", async () => {
    const set = (p: number) => lmsCall<{ percent: number; completed_at: Date | null }>(db, U.r1a,
      `SELECT * FROM authz.lms_set_my_progress($1, $2, $3)`, [batch1, c1.moduleIds[1], p]);
    const done = (await set(100))[0]!;
    expect(done.completed_at).not.toBeNull();
    const again = (await set(100))[0]!;
    expect(again.completed_at).toEqual(done.completed_at);
    const lowered = (await set(40))[0]!;
    expect([lowered.percent, lowered.completed_at]).toEqual([40, null]);
  });

  it("rejects out of range and modules of courses not in the batch; a staff override works", async () => {
    await expect(lmsCall(db, U.r1a, `SELECT * FROM authz.lms_set_my_progress($1, $2, 101)`, [batch1, c1.moduleIds[0]])).rejects.toMatchObject({ message: "invalid_input" });
    const other = await newCourse(db, U.hr, "Other", [{ title: "m", durationMinutes: 5 }]);
    await expect(lmsCall(db, U.r1a, `SELECT * FROM authz.lms_set_my_progress($1, $2, 10)`, [batch1, other.moduleIds[0]])).rejects.toMatchObject({ message: "course_not_in_batch" });
    const r = await lmsCall(db, U.coach, `SELECT * FROM authz.lms_set_progress($1, $2, $3, 70)`, [batch1, U.r1a, c1.moduleIds[0]]);
    expect(r[0]!.percent).toBe(70);
  });
});

describe("structure rules", () => {
  it("add_students: unknown or inactive users are refused; duplicates ignored", async () => {
    await expect(lmsCall(db, U.hr, `SELECT authz.lms_add_students($1, $2::uuid[])`, [batch1, [inactive]])).rejects.toMatchObject({ message: "student_not_found" });
    const n = await lmsCall<{ n: number }>(db, U.hr, `SELECT authz.lms_add_students($1, $2::uuid[]) AS n`, [batch1, [U.r1a, U.r2a, U.r2a]]);
    expect(n[0]!.n).toBe(1);
    await lmsCall(db, U.hr, `SELECT authz.lms_remove_student($1, $2)`, [batch1, U.r2a]);
  });

  it("set_modules keeps ids, reorders, removes with progress, refuses foreign ids and archived courses", async () => {
    const c = await newCourse(db, U.hr, "Mods", [{ title: "a", durationMinutes: 1 }, { title: "b", durationMinutes: 2 }, { title: "c", durationMinutes: 3 }]);
    const [a, b] = c.moduleIds;
    await lmsCall(db, U.hr, `SELECT authz.lms_set_batch_courses($1, $2::uuid[])`, [batch1, [c1.id, c.id]]);
    await lmsCall(db, U.hr, `SELECT * FROM authz.lms_set_progress($1, $2, $3, 30)`, [batch1, U.r1a, c.moduleIds[2]]);
    const v = await lmsCall<{ v: number }>(db, U.hr, `SELECT authz.lms_set_modules($1, $2::jsonb, NULL) AS v`,
      [c.id, JSON.stringify([{ id: b, title: "b2", durationMinutes: 9 }, { id: a, title: "a", durationMinutes: 1 }, { title: "d", durationMinutes: 4 }])]);
    expect(v[0]!.v).toBeGreaterThan(1);
    const mods = await db.admin.query(`SELECT id, position, title FROM eureka.lms_module WHERE course_id = $1 ORDER BY position`, [c.id]);
    expect(mods.rows.map((m) => [m.position, m.title])).toEqual([[1, "b2"], [2, "a"], [3, "d"]]);
    expect(mods.rows[0]!.id).toBe(b);
    expect((await db.admin.query(`SELECT 1 FROM eureka.lms_module_progress WHERE module_id = $1`, [c.moduleIds[2]])).rowCount).toBe(0);
    await expect(lmsCall(db, U.hr, `SELECT authz.lms_set_modules($1, $2::jsonb, NULL)`, [c.id, JSON.stringify([{ id: c1.moduleIds[0], title: "x", durationMinutes: 1 }])])).rejects.toMatchObject({ message: "invalid_module" });
    await lmsCall(db, U.hr, `SELECT authz.lms_update_course($1, NULL, '{"archived":true}')`, [c.id]);
    await expect(lmsCall(db, U.hr, `SELECT authz.lms_set_modules($1, '[]', NULL)`, [c.id])).rejects.toMatchObject({ message: "course_archived" });
    await expect(lmsCall(db, U.hr, `SELECT authz.lms_set_batch_courses($1, $2::uuid[])`, [batch2, [c1.id, c.id]])).rejects.toMatchObject({ message: "course_archived" });
    // removing a course that has progress is refused
    await lmsCall(db, U.hr, `SELECT * FROM authz.lms_set_progress($1, $2, $3, 30)`, [batch1, U.r1a, b]);
    await expect(lmsCall(db, U.hr, `SELECT authz.lms_set_batch_courses($1, $2::uuid[])`, [batch1, [c1.id]])).rejects.toMatchObject({ message: "course_has_progress" });
  });

  it("update_course: version check; server stamps version and archived_at", async () => {
    const c = await newCourse(db, U.hr, "Ver");
    const v1 = (await lmsCall<{ v: number }>(db, U.hr, `SELECT authz.lms_update_course($1, 1, '{"title":"Ver2"}') AS v`, [c.id]))[0]!.v;
    expect(v1).toBe(2);
    await expect(lmsCall(db, U.hr, `SELECT authz.lms_update_course($1, 1, '{"title":"Ver3"}')`, [c.id])).rejects.toMatchObject({ message: "stale" });
    await expect(lmsCall(db, U.hr, `SELECT authz.lms_update_course($1, 2, '{"title":""}')`, [c.id])).rejects.toMatchObject({ message: "invalid_input" });
    await lmsCall(db, U.hr, `SELECT authz.lms_update_course($1, 2, '{"archived":true}')`, [c.id]);
    expect((await db.admin.query(`SELECT archived_at FROM eureka.lms_course WHERE id = $1`, [c.id])).rows[0]!.archived_at).not.toBeNull();
  });

  it("delete_batch: refused with progress, allowed without (cascading enrollments and course links)", async () => {
    await expect(lmsCall(db, U.hr, `SELECT authz.lms_delete_batch($1)`, [batch1])).rejects.toMatchObject({ message: "batch_has_progress" });
    const b = await newBatch(db, U.hr, "Empty");
    await lmsCall(db, U.hr, `SELECT authz.lms_set_batch_courses($1, $2::uuid[])`, [b, [c1.id]]);
    await lmsCall(db, U.hr, `SELECT authz.lms_add_students($1, $2::uuid[])`, [b, [U.r3a]]);
    await lmsCall(db, U.hr, `SELECT authz.lms_delete_batch($1)`, [b]);
    expect((await db.admin.query(`SELECT 1 FROM eureka.lms_enrollment WHERE batch_id = $1`, [b])).rowCount).toBe(0);
  });

  it("remove_student deletes that student's progress only", async () => {
    await lmsCall(db, U.hr, `SELECT authz.lms_add_students($1, $2::uuid[])`, [batch2, [U.r2a]]);
    await lmsCall(db, U.hr, `SELECT * FROM authz.lms_set_progress($1, $2, $3, 20)`, [batch2, U.r2a, c1.moduleIds[0]]);
    await lmsCall(db, U.hr, `SELECT authz.lms_remove_student($1, $2)`, [batch2, U.r2a]);
    const left = await db.admin.query(`SELECT user_id FROM eureka.lms_module_progress WHERE batch_id = $1`, [batch2]);
    expect(left.rows).toEqual([{ user_id: U.r1b }]);
  });

  it("batch dates and year are validated", async () => {
    await expect(lmsCall(db, U.hr, `SELECT authz.lms_create_batch('x', '2026-03-01', '2026-02-01', NULL)`)).rejects.toMatchObject({ message: "invalid_input" });
    const b = await newBatch(db, U.hr, "Y", "2027-02-01", "2027-03-01");
    expect((await db.admin.query(`SELECT year FROM eureka.lms_batch WHERE id = $1`, [b])).rows[0]!.year).toBe(2027);
    await expect(lmsCall(db, U.hr, `SELECT authz.lms_update_batch($1, '{"endDate":"2027-01-01"}')`, [b])).rejects.toMatchObject({ message: "invalid_input" });
  });
});

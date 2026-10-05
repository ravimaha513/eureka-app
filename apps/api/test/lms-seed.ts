import { asUser, type TestDb } from "./db-harness.js";

/** Calls an LMS definer function as `actor` (committed) and returns the rows. */
export const lmsCall = <R = Record<string, any>>(db: TestDb, actor: string, sql: string, params: unknown[] = []) =>
  asUser(db.app, actor, async (c) => (await c.query(sql, params)).rows as R[], true);

export const newCourse = async (db: TestDb, actor: string, title: string, mods: { title: string; durationMinutes: number }[] = []) => {
  const id = (await lmsCall<{ id: string }>(db, actor, `SELECT authz.lms_create_course($1, $2) AS id`, [title, ""]))[0]!.id;
  if (mods.length) await lmsCall(db, actor, `SELECT authz.lms_set_modules($1, $2::jsonb, NULL)`, [id, JSON.stringify(mods)]);
  const modules = await db.admin.query<{ id: string }>(`SELECT id FROM eureka.lms_module WHERE course_id = $1 ORDER BY position`, [id]);
  return { id, moduleIds: modules.rows.map((r) => r.id) };
};

export const newBatch = async (db: TestDb, actor: string, name: string, start = "2026-01-05", end = "2026-03-30") =>
  (await lmsCall<{ id: string }>(db, actor, `SELECT authz.lms_create_batch($1, $2::date, $3::date, NULL) AS id`, [name, start, end]))[0]!.id;

import type pg from "pg";
import { U } from "../../test/fixtures.js";

const HR = U.hr;
const STUDENTS = [U.r1a, U.r1b, U.r2a];

/**
 * Fictional LMS data for local development: two courses with modules, two training batches and
 * three students with partial progress. Goes through the same definer functions as the API
 * (acting as the HR fixture user), so every guard and rule applies. Skipped once any course exists.
 */
export async function seedDevLms(admin: pg.Pool): Promise<{ courses: number; batches: number }> {
  if ((await admin.query(`SELECT 1 FROM eureka.lms_course LIMIT 1`)).rowCount) return { courses: 0, batches: 0 };
  if (!(await admin.query(`SELECT 1 FROM eureka.app_user WHERE id = $1`, [HR])).rowCount) return { courses: 0, batches: 0 };
  const c = await admin.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('eureka.user_id', $1, true)", [HR]);
    const one = async <T,>(sql: string, p: unknown[] = []) => (await c.query(sql, p)).rows[0] as T;
    const course = async (title: string, description: string, mods: [string, number][]) => {
      const { id } = await one<{ id: string }>(`SELECT authz.lms_create_course($1, $2) AS id`, [title, description]);
      await c.query(`SELECT authz.lms_set_modules($1, $2::jsonb, NULL)`, [id, JSON.stringify(mods.map(([title, durationMinutes]) => ({ title, durationMinutes })))]);
      const m = (await c.query<{ id: string }>(`SELECT id FROM eureka.lms_module WHERE course_id = $1 ORDER BY position`, [id])).rows;
      return { id, modules: m.map((r) => r.id) };
    };
    const sales = await course("Sales Fundamentals", "How the Eureka sales cycle works, from sourcing to submission.",
      [["Sourcing candidates", 90], ["Qualifying a requirement", 60], ["Submitting and follow-up", 120]]);
    const comms = await course("Interview Communication", "Clear, confident answers for client interviews.",
      [["Introducing yourself", 45], ["Answering behavioural questions", 90], ["Mock interview", 120], ["Feedback review", 30]]);
    const year = new Date().getUTCFullYear();
    const batch = async (name: string, start: string, end: string, courses: string[], students: string[]) => {
      const { id } = await one<{ id: string }>(`SELECT authz.lms_create_batch($1, $2::date, $3::date, NULL) AS id`, [name, start, end]);
      await c.query(`SELECT authz.lms_set_batch_courses($1, $2::uuid[])`, [id, courses]);
      await c.query(`SELECT authz.lms_add_students($1, $2::uuid[])`, [id, students]);
      return id;
    };
    const b1 = await batch(`Spring ${year} Cohort`, `${year}-01-05`, `${year}-12-18`, [sales.id, comms.id], STUDENTS);
    await batch(`Autumn ${year + 1} Cohort`, `${year + 1}-09-01`, `${year + 1}-12-15`, [sales.id], [STUDENTS[0]!]);
    const set = (user: string, module: string, pct: number) => c.query(`SELECT * FROM authz.lms_set_progress($1, $2, $3, $4)`, [b1, user, module, pct]);
    await set(STUDENTS[0]!, sales.modules[0]!, 100); await set(STUDENTS[0]!, sales.modules[1]!, 100); await set(STUDENTS[0]!, sales.modules[2]!, 40);
    await set(STUDENTS[0]!, comms.modules[0]!, 100);
    await set(STUDENTS[1]!, sales.modules[0]!, 60);
    await c.query("COMMIT");
    return { courses: 2, batches: 2 };
  } catch (err) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    c.release();
  }
}

/**
 * Local development only: fictional courses, one training batch and some
 * module progress on top of the dev fixtures (docs/training-api.md), so the
 * Training Batches and Courses screens and the profile card have something to
 * show. Everything is written as the acting user through the app role (RLS,
 * guards and the definer functions of migration 0065 apply). Idempotent: does
 * nothing when a course already exists.
 */
import type pg from "pg";

const uid = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const LOC_DALLAS = "00000000-0000-0000-0000-00000000d001";
const JAVA = uid(501);
const U = { coach: uid(13), locD: uid(14) };

/** Fictional curriculum (not product content). */
const COURSES: { title: string; description: string; color: string; icon: string; modules: [string, number][] }[] = [
  { title: "Full Stack Development", description: "Fictional sample course for local development.", color: "indigo", icon: "code",
    modules: [["HTML and CSS refresher", 150]] },
  { title: "Database", description: "Fictional sample course: relational modelling and SQL.", color: "teal", icon: "database",
    modules: [["Relational modelling", 90], ["SQL basics", 60], ["Joins and aggregates", 60], ["Indexes", 30]] },
  { title: "Java Core", description: "Fictional sample course.", color: "amber", icon: "book",
    modules: [["Syntax and types", 60], ["Collections", 60], ["Streams", 45], ["Exceptions", 30], ["Testing", 60], ["Build tools", 45], ["Project", 90]] },
  { title: "Git Concepts", description: "Fictional sample course.", color: "violet", icon: "cloud", modules: [] },
];

async function asUser<T>(admin: pg.Pool, userId: string, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await admin.connect();
  try {
    await c.query("BEGIN");
    await c.query("SET LOCAL ROLE eureka_app");
    await c.query("SELECT set_config('eureka.user_id', $1, true)", [userId]);
    const out = await fn(c);
    await c.query("COMMIT");
    return out;
  } catch (err) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    c.release();
  }
}

export async function seedDevTraining(admin: pg.Pool): Promise<{ courses: number; students: number; completions: number }> {
  if ((await admin.query("SELECT 1 FROM eureka.course LIMIT 1")).rowCount) return { courses: 0, students: 0, completions: 0 };
  // The Dallas Location Ops Admin builds the library and a batch trained by the fixture coach.
  const { courseIds, modules, batchId } = await asUser(admin, U.locD, async (c) => {
    const courseIds: string[] = [];
    const modules: string[][] = [];
    for (const co of COURSES) {
      const id = (await c.query<{ id: string }>(
        `INSERT INTO eureka.course (location_id, title, description, cover_color, cover_icon) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [LOC_DALLAS, co.title, co.description, co.color, co.icon])).rows[0]!.id;
      courseIds.push(id);
      const ids: string[] = [];
      for (const [i, [title, minutes]] of co.modules.entries()) {
        ids.push((await c.query<{ id: string }>(
          `INSERT INTO eureka.course_module (course_id, position, title, duration_minutes, resource_urls) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
          [id, i + 1, title, minutes, i === 0 ? ["https://example.com/training/sample"] : []])).rows[0]!.id);
      }
      modules.push(ids);
    }
    const start = new Date();
    start.setUTCDate(start.getUTCDate() - 14);
    const end = new Date(start);
    end.setUTCMonth(end.getUTCMonth() + 9);
    const day = (d: Date) => d.toISOString().slice(0, 10);
    const batchId = (await c.query<{ id: string }>(`SELECT authz.create_batch($1, $2, $3::date, 25) AS id`, [LOC_DALLAS, JAVA, day(start)])).rows[0]!.id;
    await c.query(`SELECT authz.update_batch($1, 1, $2, $3, $4::date, $5::date, 25, 'violet', 'users')`,
      [batchId, `Java ${start.getUTCFullYear()}`, U.coach, day(start), day(end)]);
    await c.query(`SELECT authz.set_batch_status($1, 'in_training')`, [batchId]);
    for (const [i, id] of courseIds.entries()) {
      await c.query(`INSERT INTO eureka.batch_course (batch_id, course_id, position) VALUES ($1, $2, $3)`, [batchId, id, i + 1]);
    }
    return { courseIds, modules, batchId };
  });
  // Four Dallas candidates (fictional fixtures) join; any batch they were in is left.
  const students = (await admin.query<{ id: string }>(
    `SELECT id FROM eureka.candidate WHERE location_id = $1 AND batch_id IS NULL ORDER BY id LIMIT 4`, [LOC_DALLAS])).rows.map((r) => r.id);
  await asUser(admin, U.locD, async (c) => {
    for (const s of students) await c.query(`SELECT authz.set_batch_student($1, $2, true)`, [batchId, s]);
  });
  // The trainer records progress: the n-th student has finished the first n modules of each course.
  let completions = 0;
  await asUser(admin, U.coach, async (c) => {
    for (const [n, s] of students.entries()) {
      for (const ids of modules) {
        for (const m of ids.slice(0, n + 1)) {
          await c.query(`SELECT authz.set_module_progress($1, $2, $3, true)`, [batchId, s, m]);
          completions++;
        }
      }
    }
  });
  return { courses: courseIds.length, students: students.length, completions };
}

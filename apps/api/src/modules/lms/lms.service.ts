import { ForbiddenException, Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import type pg from "pg";
import { resolveScope, type UserAccess } from "@eureka/shared";
import { AuditService } from "../../platform/audit.service.js";
import type { AuthedUser } from "../../platform/auth.guard.js";
import { DbService } from "../../platform/db.service.js";
import { batchStatus, coursePercent, round, studentPercent } from "./lms.calc.js";
import { mapLmsError } from "./lms.errors.js";
import type { BatchCreate, BatchListQuery, BatchPatch, CourseCreate, CourseListQuery, CoursePatch, ModulesPut, StudentListQuery } from "./lms.schemas.js";

/**
 * LMS (migration 0082, docs/lms-api.md). Reads run under the caller's RLS; writes go through the
 * definer functions (which re-check lms:manage / lms:learn). Read-before-write: 404 when not
 * visible (learners: not enrolled), 403 when visible but not allowed. Audit rows hold ids and counts only.
 */
interface CourseRow {
  id: string; title: string; description: string; archived_at: Date | null; version: number;
  module_count: number; total_minutes: number; ca: string;
}
interface BatchRow {
  id: string; name: string; year: number; start_date: string; end_date: string; archived_at: Date | null; ca: string;
  created_by_name: string | null; student_count: number; course_count: number; total_minutes: number; status: string;
}
interface ModuleRow { id: string; course_id: string; position: number; title: string; duration_minutes: number }
export interface BatchCourse { id: string; title: string; moduleCount: number; totalMinutes: number; modules: { id: string; position: number; title: string; durationMinutes: number }[] }

const COURSE_SELECT = `
  SELECT c.id, c.title, c.description, c.archived_at, c.version, c.created_at::text AS ca,
         (SELECT count(*) FROM eureka.lms_module m WHERE m.course_id = c.id)::int AS module_count,
         (SELECT coalesce(sum(m.duration_minutes), 0) FROM eureka.lms_module m WHERE m.course_id = c.id)::int AS total_minutes
  FROM eureka.lms_course c`;

const presentCourse = (r: CourseRow) => ({
  id: r.id, title: r.title, description: r.description, moduleCount: r.module_count, totalMinutes: r.total_minutes,
  archivedAt: r.archived_at, version: r.version,
});

/** Staff view: counts over all students; status from dates and from every student's progress. */
const BATCH_SELECT = `
  SELECT b.id, b.name, b.year, b.start_date::text, b.end_date::text, b.archived_at, b.created_at::text AS ca,
         u.display_name AS created_by_name, s.student_count, s.course_count, s.total_minutes,
         CASE WHEN CURRENT_DATE < b.start_date THEN 'not_started'
              WHEN CURRENT_DATE > b.end_date OR s.all_done THEN 'completed' ELSE 'in_progress' END AS status
  FROM eureka.lms_batch b
  LEFT JOIN eureka.app_user u ON u.id = b.created_by
  CROSS JOIN LATERAL (SELECT
    (SELECT count(*) FROM eureka.lms_enrollment e WHERE e.batch_id = b.id)::int AS student_count,
    (SELECT count(*) FROM eureka.lms_batch_course bc WHERE bc.batch_id = b.id)::int AS course_count,
    (SELECT coalesce(sum(m.duration_minutes), 0) FROM eureka.lms_batch_course bc
       JOIN eureka.lms_module m ON m.course_id = bc.course_id WHERE bc.batch_id = b.id)::int AS total_minutes,
    (EXISTS (SELECT 1 FROM eureka.lms_enrollment e WHERE e.batch_id = b.id)
     AND EXISTS (SELECT 1 FROM eureka.lms_batch_course bc JOIN eureka.lms_module m ON m.course_id = bc.course_id WHERE bc.batch_id = b.id)
     AND NOT EXISTS (SELECT 1 FROM eureka.lms_enrollment e
                       JOIN eureka.lms_batch_course bc ON bc.batch_id = e.batch_id
                       JOIN eureka.lms_module m ON m.course_id = bc.course_id
                       LEFT JOIN eureka.lms_module_progress p
                         ON p.batch_id = e.batch_id AND p.user_id = e.user_id AND p.module_id = m.id
                      WHERE e.batch_id = b.id AND coalesce(p.percent, 0) < 100)) AS all_done
  ) s`;

const presentBatch = (r: BatchRow) => ({
  id: r.id, name: r.name, year: r.year, startDate: r.start_date, endDate: r.end_date, status: r.status,
  studentCount: r.student_count, courseCount: r.course_count, totalMinutes: r.total_minutes,
  createdByName: r.created_by_name, archivedAt: r.archived_at,
});

const CURSOR = /^[0-9A-Za-z :.+-]+\|[0-9a-f-]{36}$/i;
const likePattern = (s: string) => `%${s.replace(/[%_\\]/g, "\\$&")}%`;

@Injectable()
export class LmsService {
  constructor(private readonly db: DbService, private readonly audit: AuditService) {}

  private requireManage(access: UserAccess) {
    if (!resolveScope(access, "lms:manage")?.all) throw new ForbiddenException("Not permitted");
  }
  private requireLearn(access: UserAccess) {
    if (!resolveScope(access, "lms:learn")) throw new ForbiddenException("Not permitted");
  }
  private cursor(raw: string | undefined): [string, string] | null {
    if (raw === undefined) return null;
    if (!CURSOR.test(raw)) throw new UnprocessableEntityException("invalid_cursor");
    const i = raw.lastIndexOf("|");
    return [raw.slice(0, i), raw.slice(i + 1)];
  }

  // ---------------------------------------------------------------- courses
  async listCourses(user: AuthedUser, q: CourseListQuery) {
    this.requireManage(user.access);
    const cur = this.cursor(q.cursor);
    const params: unknown[] = [];
    const p = (v: unknown) => { params.push(v); return `$${params.length}`; };
    const where = [q.archived ? "c.archived_at IS NOT NULL" : "c.archived_at IS NULL"];
    if (q.q) where.push(`c.title ILIKE ${p(likePattern(q.q))} ESCAPE '\\'`);
    if (cur) where.push(`(c.created_at, c.id) < (${p(cur[0])}::timestamptz, ${p(cur[1])}::uuid)`);
    const rows = await this.db.withUser(user.id, async (c) =>
      (await c.query<CourseRow>(`${COURSE_SELECT} WHERE ${where.join(" AND ")} ORDER BY c.created_at DESC, c.id DESC LIMIT ${p(q.limit + 1)}`, params)).rows);
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    return { items: page.map(presentCourse), nextCursor: rows.length > q.limit && last ? `${last.ca}|${last.id}` : null };
  }

  private async loadCourse(c: pg.PoolClient, id: string) {
    const row = (await c.query<CourseRow>(`${COURSE_SELECT} WHERE c.id = $1`, [id])).rows[0];
    if (!row) throw new NotFoundException();
    const modules = (await c.query<ModuleRow>(
      `SELECT id, course_id, position, title, duration_minutes FROM eureka.lms_module WHERE course_id = $1 ORDER BY position`, [id])).rows;
    return {
      ...presentCourse(row),
      modules: modules.map((m) => ({ id: m.id, position: m.position, title: m.title, durationMinutes: m.duration_minutes })),
    };
  }

  async getCourse(user: AuthedUser, id: string) {
    this.requireManage(user.access);
    return this.db.withUser(user.id, (c) => this.loadCourse(c, id));
  }

  async createCourse(user: AuthedUser, body: CourseCreate) {
    this.requireManage(user.access);
    return this.db.withUser(user.id, async (c) => {
      let id: string;
      try {
        id = (await c.query<{ id: string }>(`SELECT authz.lms_create_course($1, $2) AS id`, [body.title, body.description ?? ""])).rows[0]!.id;
      } catch (err) { mapLmsError(err); }
      await this.audit.record(c, { actorId: user.id, action: "lms.course.created", entityType: "lms_course", entityId: id });
      return this.loadCourse(c, id);
    });
  }

  async updateCourse(user: AuthedUser, id: string, version: number, body: CoursePatch) {
    this.requireManage(user.access);
    return this.db.withUser(user.id, async (c) => {
      await this.loadCourse(c, id); // 404 first
      try {
        await c.query(`SELECT authz.lms_update_course($1, $2, $3::jsonb)`, [id, version, JSON.stringify(body)]);
      } catch (err) { mapLmsError(err); }
      await this.audit.record(c, { actorId: user.id, action: "lms.course.updated", entityType: "lms_course", entityId: id, changes: { fields: Object.keys(body) } });
      return this.loadCourse(c, id);
    });
  }

  async setModules(user: AuthedUser, id: string, version: number | null, body: ModulesPut) {
    this.requireManage(user.access);
    return this.db.withUser(user.id, async (c) => {
      await this.loadCourse(c, id);
      try {
        await c.query(`SELECT authz.lms_set_modules($1, $2::jsonb, $3)`, [id, JSON.stringify(body.modules), version]);
      } catch (err) { mapLmsError(err); }
      await this.audit.record(c, { actorId: user.id, action: "lms.course.modules_set", entityType: "lms_course", entityId: id, changes: { moduleCount: body.modules.length } });
      return this.loadCourse(c, id);
    });
  }

  // ---------------------------------------------------------------- batches
  async listBatches(user: AuthedUser, q: BatchListQuery) {
    this.requireManage(user.access);
    const cur = this.cursor(q.cursor);
    const params: unknown[] = [];
    const p = (v: unknown) => { params.push(v); return `$${params.length}`; };
    const where = [q.archived ? "b.archived_at IS NOT NULL" : "b.archived_at IS NULL"];
    if (q.q) where.push(`b.name ILIKE ${p(likePattern(q.q))} ESCAPE '\\'`);
    if (q.status) where.push(`status = ${p(q.status)}`);
    if (cur) where.push(`(b.start_date, b.id) < (${p(cur[0])}::date, ${p(cur[1])}::uuid)`);
    const sql = `SELECT * FROM (${BATCH_SELECT}) b WHERE ${where.join(" AND ")} ORDER BY b.start_date DESC, b.id DESC LIMIT ${p(q.limit + 1)}`;
    const rows = await this.db.withUser(user.id, async (c) => (await c.query<BatchRow>(sql, params)).rows);
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    return { items: page.map(presentBatch), nextCursor: rows.length > q.limit && last ? `${last.start_date}|${last.id}` : null };
  }

  /** Courses of a batch with their modules, in assigned order (RLS decides what the caller sees). */
  private async batchCourses(c: pg.PoolClient, batchId: string): Promise<BatchCourse[]> {
    const courses = (await c.query<{ id: string; title: string }>(
      `SELECT c.id, c.title FROM eureka.lms_batch_course bc JOIN eureka.lms_course c ON c.id = bc.course_id
       WHERE bc.batch_id = $1 ORDER BY bc.position, c.id`, [batchId])).rows;
    const mods = (await c.query<ModuleRow>(
      `SELECT m.id, m.course_id, m.position, m.title, m.duration_minutes FROM eureka.lms_batch_course bc
       JOIN eureka.lms_module m ON m.course_id = bc.course_id WHERE bc.batch_id = $1 ORDER BY m.course_id, m.position`, [batchId])).rows;
    return courses.map((co) => {
      const modules = mods.filter((m) => m.course_id === co.id)
        .map((m) => ({ id: m.id, position: m.position, title: m.title, durationMinutes: m.duration_minutes }));
      return { id: co.id, title: co.title, moduleCount: modules.length, totalMinutes: modules.reduce((s, m) => s + m.durationMinutes, 0), modules };
    });
  }

  private async loadBatch(c: pg.PoolClient, id: string) {
    const row = (await c.query<BatchRow>(`${BATCH_SELECT} WHERE b.id = $1`, [id])).rows[0];
    if (!row) throw new NotFoundException();
    return { ...presentBatch(row), courses: await this.batchCourses(c, id) };
  }

  async getBatch(user: AuthedUser, id: string) {
    this.requireManage(user.access);
    return this.db.withUser(user.id, (c) => this.loadBatch(c, id));
  }

  async createBatch(user: AuthedUser, body: BatchCreate) {
    this.requireManage(user.access);
    return this.db.withUser(user.id, async (c) => {
      let id: string;
      try {
        id = (await c.query<{ id: string }>(`SELECT authz.lms_create_batch($1, $2::date, $3::date, $4::int) AS id`,
          [body.name, body.startDate, body.endDate, body.year ?? null])).rows[0]!.id;
      } catch (err) { mapLmsError(err); }
      await this.audit.record(c, { actorId: user.id, action: "lms.batch.created", entityType: "lms_batch", entityId: id });
      return this.loadBatch(c, id);
    });
  }

  async updateBatch(user: AuthedUser, id: string, body: BatchPatch) {
    this.requireManage(user.access);
    return this.db.withUser(user.id, async (c) => {
      await this.loadBatch(c, id);
      try {
        await c.query(`SELECT authz.lms_update_batch($1, $2::jsonb)`, [id, JSON.stringify(body)]);
      } catch (err) { mapLmsError(err); }
      await this.audit.record(c, { actorId: user.id, action: "lms.batch.updated", entityType: "lms_batch", entityId: id, changes: { fields: Object.keys(body) } });
      return this.loadBatch(c, id);
    });
  }

  async deleteBatch(user: AuthedUser, id: string) {
    this.requireManage(user.access);
    await this.db.withUser(user.id, async (c) => {
      await this.loadBatch(c, id);
      try {
        await c.query(`SELECT authz.lms_delete_batch($1)`, [id]);
      } catch (err) { mapLmsError(err); }
      await this.audit.record(c, { actorId: user.id, action: "lms.batch.deleted", entityType: "lms_batch", entityId: id });
    });
  }

  async setBatchCourses(user: AuthedUser, id: string, courseIds: string[]) {
    this.requireManage(user.access);
    return this.db.withUser(user.id, async (c) => {
      await this.loadBatch(c, id);
      try {
        await c.query(`SELECT authz.lms_set_batch_courses($1, $2::uuid[])`, [id, courseIds]);
      } catch (err) { mapLmsError(err); }
      await this.audit.record(c, { actorId: user.id, action: "lms.batch.courses_set", entityType: "lms_batch", entityId: id, changes: { courseCount: courseIds.length } });
      return this.loadBatch(c, id);
    });
  }

  // ---------------------------------------------------------------- students
  async listStudents(user: AuthedUser, batchId: string, q: StudentListQuery) {
    this.requireManage(user.access);
    const cur = this.cursor(q.cursor);
    return this.db.withUser(user.id, async (c) => {
      if (!(await c.query(`SELECT 1 FROM eureka.lms_batch WHERE id = $1`, [batchId])).rowCount) throw new NotFoundException();
      const params: unknown[] = [batchId];
      const p = (v: unknown) => { params.push(v); return `$${params.length}`; };
      const where = ["e.batch_id = $1"];
      if (q.q) { const l = p(likePattern(q.q)); where.push(`(u.display_name ILIKE ${l} ESCAPE '\\' OR u.email::text ILIKE ${l} ESCAPE '\\')`); }
      if (cur) where.push(`(e.enrolled_at, e.user_id) > (${p(cur[0])}::timestamptz, ${p(cur[1])}::uuid)`);
      const rows = (await c.query<{ user_id: string; name: string; email: string; ea: string }>(
        `SELECT e.user_id, u.display_name AS name, u.email::text AS email, e.enrolled_at::text AS ea
         FROM eureka.lms_enrollment e JOIN eureka.app_user u ON u.id = e.user_id
         WHERE ${where.join(" AND ")} ORDER BY e.enrolled_at, e.user_id LIMIT ${p(q.limit + 1)}`, params)).rows;
      const page = rows.slice(0, q.limit);
      const courses = await this.batchCourses(c, batchId);
      const prog = page.length === 0 ? [] : (await c.query<{ user_id: string; module_id: string; percent: number }>(
        `SELECT user_id, module_id, percent FROM eureka.lms_module_progress WHERE batch_id = $1 AND user_id = ANY($2::uuid[])`,
        [batchId, page.map((r) => r.user_id)])).rows;
      const byUser = new Map<string, Map<string, number>>();
      for (const r of prog) {
        if (!byUser.has(r.user_id)) byUser.set(r.user_id, new Map());
        byUser.get(r.user_id)!.set(r.module_id, r.percent);
      }
      const last = page[page.length - 1];
      return {
        items: page.map((r) => {
          const mine = byUser.get(r.user_id) ?? new Map<string, number>();
          const cs = courses.map((co) => {
            const pct = coursePercent(co.modules, (mid) => mine.get(mid) ?? 0);
            return {
              courseId: co.id, title: co.title, raw: pct, percent: round(pct),
              modules: co.modules.map((m) => ({ moduleId: m.id, title: m.title, durationMinutes: m.durationMinutes, percent: mine.get(m.id) ?? 0 })),
            };
          });
          return {
            userId: r.user_id, name: r.name, email: r.email, percent: round(studentPercent(cs.map((x) => x.raw))),
            courses: cs.map(({ raw: _raw, ...rest }) => rest),
          };
        }),
        nextCursor: rows.length > q.limit && last ? `${last.ea}|${last.user_id}` : null,
      };
    });
  }

  async addStudents(user: AuthedUser, batchId: string, userIds: string[]) {
    this.requireManage(user.access);
    return this.db.withUser(user.id, async (c) => {
      await this.loadBatch(c, batchId);
      let added: number;
      try {
        added = (await c.query<{ n: number }>(`SELECT authz.lms_add_students($1, $2::uuid[]) AS n`, [batchId, userIds])).rows[0]!.n;
      } catch (err) { mapLmsError(err); }
      await this.audit.record(c, { actorId: user.id, action: "lms.students.added", entityType: "lms_batch", entityId: batchId, changes: { requested: userIds.length, added } });
      return { added };
    });
  }

  async removeStudent(user: AuthedUser, batchId: string, userId: string) {
    this.requireManage(user.access);
    await this.db.withUser(user.id, async (c) => {
      await this.loadBatch(c, batchId);
      try {
        await c.query(`SELECT authz.lms_remove_student($1, $2)`, [batchId, userId]);
      } catch (err) { mapLmsError(err); }
      await this.audit.record(c, { actorId: user.id, action: "lms.student.removed", entityType: "lms_batch", entityId: batchId, changes: { userId } });
    });
  }

  async lookupStudents(user: AuthedUser, q: string | undefined) {
    this.requireManage(user.access);
    const params: unknown[] = [];
    let where = "status = 'active'";
    if (q) { params.push(likePattern(q)); where += ` AND (display_name ILIKE $1 ESCAPE '\\' OR email::text ILIKE $1 ESCAPE '\\')`; }
    const rows = await this.db.withUser(user.id, async (c) => (await c.query<{ id: string; name: string; email: string }>(
      `SELECT id, display_name AS name, email::text AS email FROM eureka.app_user WHERE ${where} ORDER BY display_name, id LIMIT 20`, params)).rows);
    return { items: rows.map((r) => ({ userId: r.id, name: r.name, email: r.email })) };
  }

  async staffSetProgress(user: AuthedUser, batchId: string, userId: string, moduleId: string, percent: number) {
    this.requireManage(user.access);
    return this.db.withUser(user.id, async (c) => {
      await this.loadBatch(c, batchId);
      const row = await this.writeProgress(c, `SELECT * FROM authz.lms_set_progress($1, $2, $3, $4)`, [batchId, userId, moduleId, percent]);
      await this.audit.record(c, { actorId: user.id, action: "lms.progress.set", entityType: "lms_batch", entityId: batchId, changes: { userId, moduleId, percent } });
      return { batchId, userId, moduleId, ...row };
    });
  }

  private async writeProgress(c: pg.PoolClient, sql: string, params: unknown[]) {
    try {
      const r = (await c.query<{ percent: number; completed_at: Date | null; updated_at: Date }>(sql, params)).rows[0]!;
      return { percent: r.percent, completedAt: r.completed_at, updatedAt: r.updated_at };
    } catch (err) { mapLmsError(err); }
  }

  // ---------------------------------------------------------------- learner
  async myTrainings(user: AuthedUser) {
    this.requireLearn(user.access);
    return this.db.withUser(user.id, async (c) => {
      const batches = (await c.query<{ id: string; name: string; start_date: string; end_date: string; today: string }>(
        `SELECT b.id, b.name, b.start_date::text, b.end_date::text, CURRENT_DATE::text AS today
         FROM eureka.lms_enrollment e JOIN eureka.lms_batch b ON b.id = e.batch_id
         WHERE e.user_id = $1 AND b.archived_at IS NULL ORDER BY b.start_date DESC, b.id DESC LIMIT 100`, [user.id])).rows;
      const items = [];
      for (const b of batches) {
        const d = await this.learnerCourses(c, b.id, user.id);
        items.push({
          batchId: b.id, name: b.name, startDate: b.start_date, endDate: b.end_date,
          status: batchStatus(b.today, b.start_date, b.end_date, d.allDone), percent: d.percent, courseCount: d.courses.length,
        });
      }
      return { items };
    });
  }

  private async learnerCourses(c: pg.PoolClient, batchId: string, userId: string) {
    const courses = await this.batchCourses(c, batchId);
    const prog = (await c.query<{ module_id: string; percent: number; completed_at: Date | null }>(
      `SELECT module_id, percent, completed_at FROM eureka.lms_module_progress WHERE batch_id = $1 AND user_id = $2`, [batchId, userId])).rows;
    const by = new Map(prog.map((r) => [r.module_id, r]));
    const cs = courses.map((co) => {
      const raw = coursePercent(co.modules, (mid) => by.get(mid)?.percent ?? 0);
      return {
        raw, out: {
          id: co.id, title: co.title, moduleCount: co.moduleCount, totalMinutes: co.totalMinutes, percent: round(raw),
          modules: co.modules.map((m) => ({
            moduleId: m.id, title: m.title, durationMinutes: m.durationMinutes,
            percent: by.get(m.id)?.percent ?? 0, completedAt: by.get(m.id)?.completed_at ?? null,
          })),
        },
      };
    });
    const allMods = courses.flatMap((co) => co.modules);
    return {
      courses: cs.map((x) => x.out),
      percent: round(studentPercent(cs.map((x) => x.raw))),
      allDone: allMods.length > 0 && allMods.every((m) => (by.get(m.id)?.percent ?? 0) === 100),
    };
  }

  async myTraining(user: AuthedUser, batchId: string) {
    this.requireLearn(user.access);
    return this.db.withUser(user.id, async (c) => {
      const b = (await c.query<{ id: string; name: string; year: number; start_date: string; end_date: string; today: string }>(
        `SELECT b.id, b.name, b.year, b.start_date::text, b.end_date::text, CURRENT_DATE::text AS today
         FROM eureka.lms_enrollment e JOIN eureka.lms_batch b ON b.id = e.batch_id
         WHERE e.user_id = $1 AND e.batch_id = $2 AND b.archived_at IS NULL`, [user.id, batchId])).rows[0];
      if (!b) throw new NotFoundException();
      const d = await this.learnerCourses(c, batchId, user.id);
      return {
        batchId: b.id, name: b.name, year: b.year, startDate: b.start_date, endDate: b.end_date,
        status: batchStatus(b.today, b.start_date, b.end_date, d.allDone), percent: d.percent, courseCount: d.courses.length,
        courses: d.courses,
      };
    });
  }

  async mySetProgress(user: AuthedUser, batchId: string, moduleId: string, percent: number) {
    this.requireLearn(user.access);
    return this.db.withUser(user.id, async (c) => {
      const enrolled = (await c.query(
        `SELECT 1 FROM eureka.lms_enrollment e JOIN eureka.lms_batch b ON b.id = e.batch_id
         WHERE e.batch_id = $1 AND e.user_id = $2 AND b.archived_at IS NULL`, [batchId, user.id])).rowCount;
      if (!enrolled) throw new NotFoundException();
      const row = await this.writeProgress(c, `SELECT * FROM authz.lms_set_my_progress($1, $2, $3)`, [batchId, moduleId, percent]);
      await this.audit.record(c, { actorId: user.id, action: "lms.progress.self", entityType: "lms_batch", entityId: batchId, changes: { moduleId, percent } });
      return { batchId, moduleId, ...row };
    });
  }
}

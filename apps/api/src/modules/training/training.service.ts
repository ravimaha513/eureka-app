import {
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import type pg from "pg";
import {
  batchDisplayName,
  canManageTraining,
  canPlanBatch,
  resolveScope,
  trainingBatchCovered,
  trainingCandidateCovered,
  trainingManageLocations,
  trainingProgress,
  type CandidateRef,
  type UserAccess,
} from "@eureka/shared";
import { AuditService } from "../../platform/audit.service.js";
import type { AuthedUser } from "../../platform/auth.guard.js";
import { DbService } from "../../platform/db.service.js";
import { scopePredicate } from "../candidates/candidates.service.js";
import { inUse, mapTrainingError } from "./training.errors.js";
import type {
  BatchListQuery,
  CreateCourse,
  CreateModule,
  CreateTrainingBatch,
  UpdateCourse,
  UpdateModule,
  UpdateTrainingBatch,
} from "./training.schemas.js";

interface BatchRow {
  id: string;
  name: string | null;
  status: string;
  start_month: string;
  start_date: string | null;
  end_date: string | null;
  size_planned: number | null;
  cover_color: string;
  cover_icon: string;
  row_version: number;
  location_id: string;
  location_name: string;
  technology_id: string;
  technology_name: string;
  trainer_id: string | null;
  trainer_name: string | null;
  covered: boolean;
  students: number;
  courses: number;
}

interface CourseModuleRow {
  course_id: string;
  title: string;
  description: string | null;
  cover_color: string;
  cover_icon: string;
  archived: boolean;
  module_id: string | null;
  module_title: string | null;
  duration_minutes: number | null;
  resource_urls: string[] | null;
}

const BATCH_SELECT = `
  SELECT b.id, b.name, b.status, b.start_month::text, b.start_date::text, b.end_date::text, b.size_planned,
         b.cover_color, b.cover_icon, b.row_version, b.location_id, l.name AS location_name,
         b.technology_id, t.name AS technology_name, b.trainer_id, u.display_name AS trainer_name,
         v.covered, v.students,
         (SELECT count(*)::int FROM eureka.batch_course bc WHERE bc.batch_id = b.id) AS courses
  FROM authz.training_batches() v
  JOIN eureka.batch b ON b.id = v.batch_id
  JOIN eureka.location l ON l.id = b.location_id
  JOIN eureka.technology t ON t.id = b.technology_id
  LEFT JOIN eureka.app_user u ON u.id = b.trainer_id`;

const like = (s: string) => `%${s.replace(/[%_\\]/g, "\\$&")}%`;

/** docs/training-api.md (migration 0065). */
@Injectable()
export class TrainingService {
  constructor(private readonly db: DbService, private readonly audit: AuditService) {}

  // ------------------------------------------------------------------ batches

  private presentBatch(access: UserAccess, b: BatchRow) {
    const ref = { locationId: b.location_id, trainerId: b.trainer_id };
    const manage = trainingBatchCovered(access, "training:manage", ref);
    return {
      id: b.id,
      name: batchDisplayName(b.name, b.technology_name, b.start_month),
      customName: b.name,
      status: b.status,
      cover: { color: b.cover_color, icon: b.cover_icon },
      location: { id: b.location_id, name: b.location_name },
      technology: { id: b.technology_id, name: b.technology_name },
      trainer: b.trainer_id ? { id: b.trainer_id, name: b.trainer_name } : null,
      startMonth: b.start_month.slice(0, 7),
      startDate: b.start_date ?? b.start_month,
      startDateSet: b.start_date !== null,
      endDate: b.end_date,
      batchYear: Number((b.start_date ?? b.start_month).slice(0, 4)),
      sizePlanned: b.size_planned,
      /** Every student when the batch is covered at batch level, else the caller's own (TR-3). */
      students: b.students,
      courses: b.courses,
      rowVersion: b.row_version,
      /** UI hints (TR-12); every write is checked again. */
      actions: {
        manage,
        delete: manage && b.covered && b.students === 0,
        updateProgress: trainingBatchCovered(access, "training.progress:update", ref) && ["planned", "in_training"].includes(b.status),
      },
    };
  }

  /** 404 unless the batch is on the caller's Training Batches screen (TR-3). */
  private async loadBatch(c: pg.PoolClient, id: string): Promise<BatchRow> {
    const row = (await c.query<BatchRow>(`${BATCH_SELECT} WHERE b.id = $1`, [id])).rows[0];
    if (!row) throw new NotFoundException();
    return row;
  }

  private async coveredFor(c: pg.PoolClient, id: string, perm: "training:manage" | "training.progress:update") {
    return (await c.query<{ ok: boolean }>(`SELECT coalesce($1 = ANY (authz.training_batch_ids($2)), false) AS ok`, [id, perm])).rows[0]!.ok;
  }

  async listBatches(user: AuthedUser, q: BatchListQuery) {
    const params: unknown[] = [];
    const where = ["true"];
    if (q.status) { params.push(q.status); where.push(`b.status = $${params.length}`); }
    if (q.cursor) {
      const [month, id] = q.cursor.split("~");
      params.push(month, id);
      where.push(`(b.start_month, b.id) < ($${params.length - 1}::date, $${params.length}::uuid)`);
    }
    params.push(q.limit + 1);
    const rows = await this.db.withUser(user.id, async (c) => (await c.query<BatchRow>(
      `${BATCH_SELECT} WHERE ${where.join(" AND ")} ORDER BY b.start_month DESC, b.id DESC LIMIT $${params.length}`, params)).rows);
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    return {
      items: page.map((b) => this.presentBatch(user.access, b)),
      nextCursor: rows.length > q.limit && last ? `${last.start_month}~${last.id}` : null,
      canCreate: canManageTraining(user.access),
    };
  }

  /** Assigned courses with their modules, in order. */
  private async batchCourses(c: pg.PoolClient, batchId: string) {
    const { rows } = await c.query<CourseModuleRow>(
      `SELECT bc.course_id, co.title, co.description, co.cover_color, co.cover_icon, co.archived,
              m.id AS module_id, m.title AS module_title, m.duration_minutes, m.resource_urls
       FROM eureka.batch_course bc
       JOIN eureka.course co ON co.id = bc.course_id
       LEFT JOIN eureka.course_module m ON m.course_id = co.id
       WHERE bc.batch_id = $1
       ORDER BY bc.position, m.position`, [batchId]);
    const out: {
      id: string; title: string; description: string | null; cover: { color: string; icon: string }; archived: boolean;
      totalMinutes: number; modules: { id: string; title: string; durationMinutes: number; resources: string[] }[];
    }[] = [];
    for (const r of rows) {
      let course = out[out.length - 1];
      if (!course || course.id !== r.course_id) {
        course = { id: r.course_id, title: r.title, description: r.description, cover: { color: r.cover_color, icon: r.cover_icon },
          archived: r.archived, totalMinutes: 0, modules: [] };
        out.push(course);
      }
      if (r.module_id) {
        course.modules.push({ id: r.module_id, title: r.module_title!, durationMinutes: r.duration_minutes!, resources: r.resource_urls ?? [] });
        course.totalMinutes += r.duration_minutes!;
      }
    }
    return out;
  }

  async getBatch(user: AuthedUser, id: string) {
    return this.db.withUser(user.id, async (c) => {
      const b = await this.loadBatch(c, id);
      return { ...this.presentBatch(user.access, b), assignedCourses: await this.batchCourses(c, id) };
    });
  }

  async createBatch(user: AuthedUser, parse: () => CreateTrainingBatch) {
    if (!canPlanBatch(user.access)) throw new ForbiddenException("Not permitted");
    const body = parse();
    return this.db.withUser(user.id, async (c) => {
      const id = (await c.query<{ id: string }>(`SELECT authz.create_batch($1, $2, $3::date, $4) AS id`,
        [body.locationId, body.technologyId, body.startDate, body.sizePlanned ?? null]).catch(mapTrainingError)).rows[0]!.id;
      await c.query(`SELECT authz.update_batch($1, 1, $2, $3, $4::date, $5::date, $6, $7, $8)`,
        [id, body.name ?? null, body.trainerId ?? null, body.startDate, body.endDate ?? null, body.sizePlanned ?? null,
          body.coverColor ?? "indigo", body.coverIcon ?? "users"]).catch(mapTrainingError);
      await this.audit.record(c, {
        actorId: user.id, action: "batch.created", entityType: "batch", entityId: id,
        changes: { locationId: body.locationId, technologyId: body.technologyId, startDate: body.startDate, endDate: body.endDate ?? null,
          trainerId: body.trainerId ?? null, sizePlanned: body.sizePlanned ?? null, named: Boolean(body.name) },
      });
      return { id };
    });
  }

  async updateBatch(user: AuthedUser, id: string, expected: number | null, parse: () => UpdateTrainingBatch) {
    return this.db.withUser(user.id, async (c) => {
      const b = await this.loadBatch(c, id);
      if (!trainingBatchCovered(user.access, "training:manage", { locationId: b.location_id, trainerId: b.trainer_id })) {
        throw new ForbiddenException("Not permitted");
      }
      const body = parse();
      if (expected === null) throw new HttpException("if_match_required", HttpStatus.PRECONDITION_REQUIRED);
      if (expected !== b.row_version) throw new HttpException("stale", HttpStatus.PRECONDITION_FAILED);
      const pick = <K extends keyof UpdateTrainingBatch, V>(k: K, cur: V) => (k in body ? (body[k] as V) : cur);
      const v = (await c.query<{ v: number }>(`SELECT authz.update_batch($1, $2, $3, $4, $5::date, $6::date, $7, $8, $9) AS v`, [
        id, expected, pick("name", b.name), pick("trainerId", b.trainer_id), body.startDate ?? b.start_date,
        pick("endDate", b.end_date), pick("sizePlanned", b.size_planned), body.coverColor ?? b.cover_color, body.coverIcon ?? b.cover_icon,
      ]).catch(mapTrainingError)).rows[0]!.v;
      await this.audit.record(c, { actorId: user.id, action: "batch.updated", entityType: "batch", entityId: id, changes: { fields: Object.keys(body).sort() } });
      return { id, rowVersion: v };
    });
  }

  async setStatus(user: AuthedUser, id: string, to: string) {
    return this.db.withUser(user.id, async (c) => {
      const b = await this.loadBatch(c, id);
      await c.query(`SELECT authz.set_batch_status($1, $2)`, [id, to]).catch(mapTrainingError);
      await this.audit.record(c, { actorId: user.id, action: "batch.status", entityType: "batch", entityId: id, changes: { from: b.status, to } });
      return { id, status: to };
    });
  }

  async deleteBatch(user: AuthedUser, id: string) {
    await this.db.withUser(user.id, async (c) => {
      await this.loadBatch(c, id);
      await c.query(`SELECT authz.delete_batch($1)`, [id]).catch(mapTrainingError);
      await this.audit.record(c, { actorId: user.id, action: "batch.deleted", entityType: "batch", entityId: id });
    });
  }

  // ------------------------------------------------------------ batch courses

  private async requireManage(c: pg.PoolClient, id: string) {
    await this.loadBatch(c, id);
    if (!(await this.coveredFor(c, id, "training:manage"))) throw new ForbiddenException("Not permitted");
  }

  async addBatchCourse(user: AuthedUser, id: string, courseId: string) {
    return this.db.withUser(user.id, async (c) => {
      await this.requireManage(c, id);
      if (!(await c.query(`SELECT 1 FROM eureka.course WHERE id = $1`, [courseId])).rowCount) {
        throw new UnprocessableEntityException("invalid_course");
      }
      await c.query(`SELECT pg_advisory_xact_lock(hashtextextended('batch_course:' || $1::text, 0))`, [id]);
      await c.query(
        `INSERT INTO eureka.batch_course (batch_id, course_id, position)
         SELECT $1, $2, coalesce(max(position), 0) + 1 FROM eureka.batch_course WHERE batch_id = $1`, [id, courseId])
        .catch((err: { code?: string }) => {
          if (err.code === "23505") throw new ConflictException("course_already_assigned");
          return mapTrainingError(err);
        });
      await this.audit.record(c, { actorId: user.id, action: "training.batch_course_added", entityType: "batch", entityId: id, changes: { courseId } });
      return { batchId: id, courseId };
    });
  }

  async removeBatchCourse(user: AuthedUser, id: string, courseId: string) {
    await this.db.withUser(user.id, async (c) => {
      await this.requireManage(c, id);
      const r = await c.query(`DELETE FROM eureka.batch_course WHERE batch_id = $1 AND course_id = $2`, [id, courseId]);
      if (!r.rowCount) throw new NotFoundException();
      await this.audit.record(c, { actorId: user.id, action: "training.batch_course_removed", entityType: "batch", entityId: id, changes: { courseId } });
    });
  }

  async reorderBatchCourses(user: AuthedUser, id: string, courseIds: string[]) {
    return this.db.withUser(user.id, async (c) => {
      await this.requireManage(c, id);
      const cur = (await c.query<{ course_id: string }>(`SELECT course_id FROM eureka.batch_course WHERE batch_id = $1`, [id])).rows.map((r) => r.course_id);
      if (cur.length !== courseIds.length || !courseIds.every((x) => cur.includes(x))) throw new UnprocessableEntityException("invalid_order");
      await c.query(
        `UPDATE eureka.batch_course bc SET position = o.ord FROM unnest($2::uuid[]) WITH ORDINALITY AS o(id, ord)
         WHERE bc.batch_id = $1 AND bc.course_id = o.id`, [id, courseIds]).catch(mapTrainingError);
      await this.audit.record(c, { actorId: user.id, action: "training.batch_courses_reordered", entityType: "batch", entityId: id, changes: { count: courseIds.length } });
      return { batchId: id, courseIds };
    });
  }

  // ----------------------------------------------------------------- students

  async students(user: AuthedUser, id: string, search: string | undefined) {
    return this.db.withUser(user.id, async (c) => {
      await this.loadBatch(c, id);
      const students = (await c.query<{ candidate_id: string; first_name: string; last_name: string; technology: string; marketing_status: string }>(
        `SELECT * FROM authz.training_batch_students($1) s
         WHERE ($2::text IS NULL OR (s.first_name || ' ' || s.last_name) ILIKE $2)
         ORDER BY s.first_name, s.last_name, s.candidate_id`, [id, search ? like(search) : null])).rows;
      const courses = await this.batchCourses(c, id);
      const modules = courses.flatMap((co) => co.modules.map((m) => ({ courseId: co.id, moduleId: m.id, durationMinutes: m.durationMinutes })));
      const done = (await c.query<{ candidate_id: string; module_id: string; completed_at: Date; completed_by: string; completed_by_name: string | null }>(
        `SELECT mp.candidate_id, mp.module_id, mp.completed_at, mp.completed_by, u.display_name AS completed_by_name
         FROM eureka.module_progress mp LEFT JOIN eureka.app_user u ON u.id = mp.completed_by
         WHERE mp.batch_id = $1`, [id])).rows;
      const byStudent = new Map<string, typeof done>();
      for (const d of done) byStudent.set(d.candidate_id, [...(byStudent.get(d.candidate_id) ?? []), d]);
      const moduleIds = new Set(modules.map((m) => m.moduleId));
      return {
        items: students.map((s) => {
          const mine = (byStudent.get(s.candidate_id) ?? []).filter((d) => moduleIds.has(d.module_id));
          const p = trainingProgress(modules, new Set(mine.map((d) => d.module_id)));
          return {
            candidateId: s.candidate_id,
            name: `${s.first_name} ${s.last_name}`,
            technology: s.technology,
            status: s.marketing_status,
            percent: p.percent,
            completedMinutes: p.completedMinutes,
            totalMinutes: p.totalMinutes,
            courses: p.courses.map((x) => ({ courseId: x.courseId, percent: x.percent, completedModules: x.completedModules, totalModules: x.totalModules })),
            completions: mine.map((d) => ({
              moduleId: d.module_id, completedAt: d.completed_at.toISOString(), completedBy: { id: d.completed_by, name: d.completed_by_name },
            })),
          };
        }),
        nextCursor: null,
      };
    });
  }

  async eligibleStudents(user: AuthedUser, id: string, search: string | undefined) {
    return this.db.withUser(user.id, async (c) => {
      const b = await this.loadBatch(c, id);
      if (!(await this.coveredFor(c, id, "training:manage"))) throw new ForbiddenException("Not permitted");
      const scope = resolveScope(user.access, "candidate:read");
      if (!scope) return { items: [], nextCursor: null };
      const params: unknown[] = [b.location_id, id, search ? like(search) : null];
      const { rows } = await c.query<{
        id: string; first_name: string; last_name: string; technology: string; marketing_status: string;
        batch_id: string | null; batch_name: string | null; batch_month: string | null; batch_technology: string | null;
      }>(
        `SELECT c.id, p.first_name, p.last_name, t.name AS technology, c.marketing_status,
                c.batch_id, ob.name AS batch_name, ob.start_month::text AS batch_month, obt.name AS batch_technology
         FROM eureka.candidate c
         JOIN eureka.person p ON p.id = c.person_id
         JOIN eureka.technology t ON t.id = c.technology_id
         LEFT JOIN eureka.batch ob ON ob.id = c.batch_id
         LEFT JOIN eureka.technology obt ON obt.id = ob.technology_id
         WHERE c.location_id = $1 AND c.batch_id IS DISTINCT FROM $2
           AND ($3::text IS NULL OR (p.first_name || ' ' || p.last_name) ILIKE $3)
           AND ${scopePredicate({ ...scope, allTeams: false, hotlistOpen: false }, params)}
         ORDER BY p.first_name, p.last_name, c.id LIMIT 50`, params);
      return {
        items: rows.map((r) => ({
          candidateId: r.id, name: `${r.first_name} ${r.last_name}`, technology: r.technology, status: r.marketing_status,
          currentBatch: r.batch_id && r.batch_month
            ? { id: r.batch_id, name: batchDisplayName(r.batch_name, r.batch_technology ?? "", r.batch_month) } : null,
        })),
        nextCursor: null,
      };
    });
  }

  async addStudent(user: AuthedUser, id: string, candidateId: string) {
    return this.db.withUser(user.id, async (c) => {
      await this.loadBatch(c, id);
      await c.query(`SELECT authz.set_batch_student($1, $2, true)`, [id, candidateId]).catch(mapTrainingError);
      await this.audit.record(c, { actorId: user.id, action: "training.student_added", entityType: "batch", entityId: id, changes: { candidateId } });
      return { batchId: id, candidateId };
    });
  }

  async removeStudent(user: AuthedUser, id: string, candidateId: string) {
    await this.db.withUser(user.id, async (c) => {
      await this.loadBatch(c, id);
      await c.query(`SELECT authz.set_batch_student($1, $2, false)`, [id, candidateId]).catch(mapTrainingError);
      await this.audit.record(c, { actorId: user.id, action: "training.student_removed", entityType: "batch", entityId: id, changes: { candidateId } });
    });
  }

  async setModuleCompletion(user: AuthedUser, id: string, candidateId: string, moduleId: string, completed: boolean) {
    return this.db.withUser(user.id, async (c) => {
      await this.loadBatch(c, id);
      const at = (await c.query<{ t: Date | null }>(`SELECT authz.set_module_progress($1, $2, $3, $4) AS t`,
        [id, candidateId, moduleId, completed]).catch(mapTrainingError)).rows[0]!.t;
      await this.audit.record(c, {
        actorId: user.id, action: "training.progress", entityType: "batch", entityId: id, changes: { candidateId, moduleId, completed },
      });
      if (!at) return { moduleId, completed: false, completedAt: null, completedBy: null };
      const by = (await c.query<{ id: string; name: string }>(
        `SELECT u.id, u.display_name AS name FROM eureka.module_progress mp JOIN eureka.app_user u ON u.id = mp.completed_by
         WHERE mp.batch_id = $1 AND mp.candidate_id = $2 AND mp.module_id = $3`, [id, candidateId, moduleId])).rows[0] ?? null;
      return { moduleId, completed: true, completedAt: at.toISOString(), completedBy: by };
    });
  }

  async trainers(user: AuthedUser) {
    return this.db.withUser(user.id, async (c) => ({
      items: (await c.query<{ id: string; name: string }>(
        `SELECT DISTINCT u.id, u.display_name AS name
         FROM eureka.app_user u
         JOIN eureka.user_role ur ON ur.user_id = u.id AND ur.valid @> now()
         JOIN eureka.role_permission rp ON rp.role_key = ur.role_key AND rp.permission = 'training.progress:update'
         WHERE u.status = 'active'
         ORDER BY name, u.id`)).rows,
    }));
  }

  /**
   * Training card of a candidate profile (TR-11): the candidate must be
   * readable (404) and its progress covered by training:read, through the
   * candidate (own/team/hierarchy/coached teams/location/org) or its batch.
   */
  async candidateTraining(user: AuthedUser, candidateId: string) {
    const readScope = resolveScope(user.access, "candidate:read");
    if (!readScope) throw new NotFoundException();
    return this.db.withUser(user.id, async (c) => {
      const params: unknown[] = [candidateId];
      const r = (await c.query<{
        recruiter_id: string | null; team_id: string; location_id: string; visibility: "team" | "all_teams"; marketing_status: string; batch_id: string | null;
      }>(`SELECT c.recruiter_id, c.team_id, c.location_id, c.visibility, c.marketing_status, c.batch_id
          FROM eureka.candidate c WHERE c.id = $1 AND ${scopePredicate(readScope, params)}`, params)).rows[0];
      if (!r) throw new NotFoundException();
      const ref: CandidateRef = { recruiterId: r.recruiter_id, teamId: r.team_id, locationId: r.location_id, visibility: r.visibility, marketingStatus: r.marketing_status };
      if (!r.batch_id) {
        if (!trainingCandidateCovered(user.access, ref)) throw new ForbiddenException("Not permitted");
        return { batch: null };
      }
      const b = (await c.query<{ name: string | null; status: string; start_month: string; start_date: string | null; end_date: string | null;
        technology: string; trainer_id: string | null; location_id: string; covered: boolean }>(
        `SELECT b.name, b.status, b.start_month::text, b.start_date::text, b.end_date::text, t.name AS technology, b.trainer_id, b.location_id,
                coalesce(b.id = ANY (authz.training_batch_ids('training:read')), false) AS covered
         FROM eureka.batch b JOIN eureka.technology t ON t.id = b.technology_id WHERE b.id = $1`, [r.batch_id])).rows[0];
      if (!b || !(b.covered || trainingCandidateCovered(user.access, ref))) throw new ForbiddenException("Not permitted");
      const courses = await this.batchCourses(c, r.batch_id);
      const modules = courses.flatMap((co) => co.modules.map((m) => ({ courseId: co.id, moduleId: m.id, durationMinutes: m.durationMinutes })));
      const done = new Set((await c.query<{ module_id: string }>(
        `SELECT module_id FROM eureka.module_progress WHERE batch_id = $1 AND candidate_id = $2`, [r.batch_id, candidateId])).rows.map((x) => x.module_id));
      const p = trainingProgress(modules, done);
      const pc = new Map(p.courses.map((x) => [x.courseId, x]));
      return {
        batch: {
          id: r.batch_id, name: batchDisplayName(b.name, b.technology, b.start_month), status: b.status,
          startDate: b.start_date ?? b.start_month, endDate: b.end_date,
        },
        percent: p.percent,
        completedMinutes: p.completedMinutes,
        totalMinutes: p.totalMinutes,
        courses: courses.map((co) => ({
          id: co.id, title: co.title, percent: pc.get(co.id)?.percent ?? 0,
          completedModules: pc.get(co.id)?.completedModules ?? 0, totalModules: co.modules.length,
        })),
      };
    });
  }

  // ------------------------------------------------------------------ courses

  private canEditCourse(access: UserAccess, locationId: string) {
    const m = trainingManageLocations(access);
    return m.all || m.locationIds.includes(locationId);
  }

  async listCourses(user: AuthedUser, includeArchived: boolean) {
    const rows = await this.db.withUser(user.id, async (c) => (await c.query<{
      id: string; title: string; description: string | null; cover_color: string; cover_icon: string; archived: boolean;
      location_id: string; location_name: string; row_version: number; modules: number; minutes: number; batches: number;
    }>(
      `SELECT co.id, co.title, co.description, co.cover_color, co.cover_icon, co.archived, co.location_id, l.name AS location_name,
              co.row_version,
              (SELECT count(*)::int FROM eureka.course_module m WHERE m.course_id = co.id) AS modules,
              (SELECT coalesce(sum(m.duration_minutes), 0)::int FROM eureka.course_module m WHERE m.course_id = co.id) AS minutes,
              (SELECT count(*)::int FROM eureka.batch_course bc
               WHERE bc.course_id = co.id AND bc.batch_id IN (SELECT v.batch_id FROM authz.training_batches() v)) AS batches
       FROM eureka.course co JOIN eureka.location l ON l.id = co.location_id
       WHERE ($1 OR NOT co.archived)
       ORDER BY co.archived, lower(co.title), co.id
       LIMIT 500`, [includeArchived])).rows);
    return {
      items: rows.map((r) => ({
        id: r.id, title: r.title, description: r.description, cover: { color: r.cover_color, icon: r.cover_icon },
        archived: r.archived, location: { id: r.location_id, name: r.location_name },
        modules: r.modules, totalMinutes: r.minutes, batches: r.batches, rowVersion: r.row_version,
        canEdit: this.canEditCourse(user.access, r.location_id),
      })),
      nextCursor: null,
      canCreate: canManageTraining(user.access),
    };
  }

  private async loadCourse(c: pg.PoolClient, id: string) {
    const r = (await c.query<{
      id: string; title: string; description: string | null; cover_color: string; cover_icon: string; archived: boolean;
      location_id: string; location_name: string; row_version: number;
    }>(`SELECT co.id, co.title, co.description, co.cover_color, co.cover_icon, co.archived, co.location_id, l.name AS location_name, co.row_version
        FROM eureka.course co JOIN eureka.location l ON l.id = co.location_id WHERE co.id = $1`, [id])).rows[0];
    if (!r) throw new NotFoundException();
    return r;
  }

  private async modules(c: pg.PoolClient, courseId: string) {
    return (await c.query<{ id: string; position: number; title: string; duration_minutes: number; resource_urls: string[]; row_version: number }>(
      `SELECT id, position, title, duration_minutes, resource_urls, row_version FROM eureka.course_module WHERE course_id = $1 ORDER BY position`,
      [courseId])).rows.map((m) => ({
      id: m.id, position: m.position, title: m.title, durationMinutes: m.duration_minutes, resources: m.resource_urls, rowVersion: m.row_version,
    }));
  }

  async getCourse(user: AuthedUser, id: string) {
    return this.db.withUser(user.id, async (c) => {
      const r = await this.loadCourse(c, id);
      const modules = await this.modules(c, id);
      return {
        id: r.id, title: r.title, description: r.description, cover: { color: r.cover_color, icon: r.cover_icon }, archived: r.archived,
        location: { id: r.location_id, name: r.location_name }, rowVersion: r.row_version,
        totalMinutes: modules.reduce((s, m) => s + m.durationMinutes, 0), modules,
        canEdit: this.canEditCourse(user.access, r.location_id),
      };
    });
  }

  async createCourse(user: AuthedUser, parse: () => CreateCourse) {
    const managed = trainingManageLocations(user.access);
    if (!managed.all && managed.locationIds.length === 0) throw new ForbiddenException("Not permitted");
    const body = parse();
    const locationId = body.locationId ?? (managed.locationIds.length === 1 ? managed.locationIds[0] : undefined);
    if (!locationId) throw new UnprocessableEntityException("location_required");
    if (!this.canEditCourse(user.access, locationId)) throw new ForbiddenException("location_not_in_scope");
    return this.db.withUser(user.id, async (c) => {
      const id = (await c.query<{ id: string }>(
        `INSERT INTO eureka.course (location_id, title, description, cover_color, cover_icon) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [locationId, body.title, body.description ?? null, body.coverColor ?? "indigo", body.coverIcon ?? "book"])
        .catch((err: { code?: string }) => {
          if (err.code === "23503") throw new UnprocessableEntityException("invalid_location");
          throw err;
        })).rows[0]!.id;
      let pos = 0;
      for (const m of body.modules ?? []) {
        pos += 1;
        await c.query(`INSERT INTO eureka.course_module (course_id, position, title, duration_minutes, resource_urls) VALUES ($1, $2, $3, $4, $5)`,
          [id, pos, m.title, m.durationMinutes, m.resources ?? []]);
      }
      await this.audit.record(c, { actorId: user.id, action: "training.course_created", entityType: "course", entityId: id, changes: { locationId, modules: pos } });
      return { id };
    });
  }

  private async loadCourseForWrite(c: pg.PoolClient, user: AuthedUser, id: string) {
    const r = await this.loadCourse(c, id);
    if (!this.canEditCourse(user.access, r.location_id)) throw new ForbiddenException("Not permitted");
    return r;
  }

  async updateCourse(user: AuthedUser, id: string, expected: number | null, parse: () => UpdateCourse) {
    return this.db.withUser(user.id, async (c) => {
      await this.loadCourseForWrite(c, user, id);
      const body = parse();
      if (expected === null) throw new HttpException("if_match_required", HttpStatus.PRECONDITION_REQUIRED);
      const map: Record<string, string> = { title: "title", description: "description", coverColor: "cover_color", coverIcon: "cover_icon", archived: "archived" };
      const params: unknown[] = [id, expected];
      const sets = Object.entries(body).map(([k, v]) => { params.push(v); return `${map[k]} = $${params.length}`; });
      const r = await c.query<{ row_version: number }>(
        `UPDATE eureka.course SET ${sets.join(", ")} WHERE id = $1 AND row_version = $2 RETURNING row_version`, params).catch(mapTrainingError);
      if (!r.rowCount) throw new HttpException("stale", HttpStatus.PRECONDITION_FAILED);
      await this.audit.record(c, { actorId: user.id, action: "training.course_updated", entityType: "course", entityId: id, changes: { fields: Object.keys(body).sort() } });
      return { id, rowVersion: r.rows[0]!.row_version };
    });
  }

  async deleteCourse(user: AuthedUser, id: string) {
    await this.db.withUser(user.id, async (c) => {
      await this.loadCourseForWrite(c, user, id);
      await c.query(`DELETE FROM eureka.course WHERE id = $1`, [id]).catch(inUse("course_in_use"));
      await this.audit.record(c, { actorId: user.id, action: "training.course_deleted", entityType: "course", entityId: id });
    });
  }

  async addModule(user: AuthedUser, courseId: string, body: CreateModule) {
    return this.db.withUser(user.id, async (c) => {
      await this.loadCourseForWrite(c, user, courseId);
      await c.query(`SELECT pg_advisory_xact_lock(hashtextextended('course_module:' || $1::text, 0))`, [courseId]);
      const r = (await c.query<{ id: string; position: number }>(
        `INSERT INTO eureka.course_module (course_id, position, title, duration_minutes, resource_urls)
         SELECT $1, coalesce(max(position), 0) + 1, $2, $3, $4 FROM eureka.course_module WHERE course_id = $1
         RETURNING id, position`, [courseId, body.title, body.durationMinutes, body.resources ?? []]).catch(mapTrainingError)).rows[0]!;
      await this.audit.record(c, { actorId: user.id, action: "training.module_created", entityType: "course", entityId: courseId, changes: { moduleId: r.id } });
      return { id: r.id, position: r.position, rowVersion: 1 };
    });
  }

  async updateModule(user: AuthedUser, courseId: string, moduleId: string, expected: number | null, parse: () => UpdateModule) {
    return this.db.withUser(user.id, async (c) => {
      await this.loadCourseForWrite(c, user, courseId);
      const exists = await c.query(`SELECT 1 FROM eureka.course_module WHERE id = $1 AND course_id = $2`, [moduleId, courseId]);
      if (!exists.rowCount) throw new NotFoundException();
      const body = parse();
      if (expected === null) throw new HttpException("if_match_required", HttpStatus.PRECONDITION_REQUIRED);
      const map: Record<string, string> = { title: "title", durationMinutes: "duration_minutes", resources: "resource_urls" };
      const params: unknown[] = [moduleId, courseId, expected];
      const sets = Object.entries(body).map(([k, v]) => { params.push(v); return `${map[k]} = $${params.length}`; });
      const r = await c.query<{ row_version: number }>(
        `UPDATE eureka.course_module SET ${sets.join(", ")} WHERE id = $1 AND course_id = $2 AND row_version = $3 RETURNING row_version`, params).catch(mapTrainingError);
      if (!r.rowCount) throw new HttpException("stale", HttpStatus.PRECONDITION_FAILED);
      await this.audit.record(c, {
        actorId: user.id, action: "training.module_updated", entityType: "course", entityId: courseId, changes: { moduleId, fields: Object.keys(body).sort() },
      });
      return { id: moduleId, rowVersion: r.rows[0]!.row_version };
    });
  }

  async deleteModule(user: AuthedUser, courseId: string, moduleId: string) {
    await this.db.withUser(user.id, async (c) => {
      await this.loadCourseForWrite(c, user, courseId);
      const r = await c.query(`DELETE FROM eureka.course_module WHERE id = $1 AND course_id = $2`, [moduleId, courseId]).catch(inUse("module_in_use"));
      if (!r.rowCount) throw new NotFoundException();
      await this.audit.record(c, { actorId: user.id, action: "training.module_deleted", entityType: "course", entityId: courseId, changes: { moduleId } });
    });
  }

  async reorderModules(user: AuthedUser, courseId: string, moduleIds: string[]) {
    return this.db.withUser(user.id, async (c) => {
      await this.loadCourseForWrite(c, user, courseId);
      const cur = (await c.query<{ id: string }>(`SELECT id FROM eureka.course_module WHERE course_id = $1`, [courseId])).rows.map((r) => r.id);
      if (cur.length !== moduleIds.length || !moduleIds.every((x) => cur.includes(x))) throw new UnprocessableEntityException("invalid_order");
      await c.query(
        `UPDATE eureka.course_module m SET position = o.ord FROM unnest($2::uuid[]) WITH ORDINALITY AS o(id, ord)
         WHERE m.course_id = $1 AND m.id = o.id`, [courseId, moduleIds]).catch(mapTrainingError);
      await this.audit.record(c, { actorId: user.id, action: "training.modules_reordered", entityType: "course", entityId: courseId, changes: { count: moduleIds.length } });
      return { courseId, moduleIds };
    });
  }
}

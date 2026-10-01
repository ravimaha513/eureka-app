import { createHash } from "node:crypto";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import type pg from "pg";
import {
  PLACEMENT_REASON_REQUIRED,
  ownsActivity,
  ownsCandidate,
  placementTransitionAllowed,
  placementTransitions,
  resolveScope,
  type UserAccess,
} from "@eureka/shared";
import { AuditService } from "../../platform/audit.service.js";
import type { AuthedUser } from "../../platform/auth.guard.js";
import { DbService } from "../../platform/db.service.js";
import { activityPredicate } from "../submissions/submissions.service.js";
import { fromMicros, splitCursor, toMicros } from "../submissions/pipeline.js";
import { mapPlacementError } from "./placements.errors.js";
import {
  IdempotencyKey,
  type CreatePlacement,
  type PlacementListQuery,
  type PlacementStatusChange,
} from "./placements.schemas.js";

interface PlacementRow {
  id: string;
  submission_id: string;
  candidate_id: string;
  candidate_name: string | null;
  /** Candidate ownership (NULL when the caller cannot read the candidate row). */
  cand_recruiter_id: string | null;
  cand_team_id: string | null;
  cand_location_id: string | null;
  recruiter_id: string;
  recruiter_name: string | null;
  team_id: string | null;
  team_name: string | null;
  location_id: string | null;
  location_name: string | null;
  client_id: string;
  client_name: string;
  vendor_id: string | null;
  vendor_name: string | null;
  implementation_partner_id: string | null;
  implementation_partner_name: string | null;
  placement_type: string;
  rate: string | null;
  work_mode: string;
  project_city: string | null;
  project_state: string | null;
  tentative_start: string;
  is_first_placement: boolean;
  status: string;
  status_changed_at: Date | null;
  created_at: Date;
  k: string;
}

const SELECT = `
  SELECT pl.id, pl.submission_id, pl.candidate_id, pl.recruiter_id, pl.team_id, pl.location_id,
         pl.client_id, pl.vendor_id, pl.implementation_partner_id, pl.placement_type, pl.rate, pl.work_mode,
         pl.project_city, pl.project_state, pl.tentative_start::text AS tentative_start, pl.is_first_placement,
         pl.status, pl.status_changed_at, pl.created_at, ${toMicros("pl.created_at")} AS k,
         c.recruiter_id AS cand_recruiter_id, c.team_id AS cand_team_id, c.location_id AS cand_location_id,
         CASE WHEN p.id IS NOT NULL THEN p.first_name || ' ' || p.last_name END AS candidate_name,
         ru.display_name AS recruiter_name, tm.name AS team_name, l.name AS location_name,
         cl.name AS client_name, v.name AS vendor_name, ip.name AS implementation_partner_name
  FROM eureka.placement pl
  LEFT JOIN eureka.candidate c ON c.id = pl.candidate_id
  LEFT JOIN eureka.person p ON p.id = c.person_id
  LEFT JOIN eureka.app_user ru ON ru.id = pl.recruiter_id
  LEFT JOIN eureka.team tm ON tm.id = pl.team_id
  LEFT JOIN eureka.location l ON l.id = pl.location_id
  JOIN eureka.client cl ON cl.id = pl.client_id
  LEFT JOIN eureka.vendor v ON v.id = pl.vendor_id
  LEFT JOIN eureka.implementation_partner ip ON ip.id = pl.implementation_partner_id`;

const actor = (r: Pick<PlacementRow, "recruiter_id" | "team_id" | "location_id">) => ({
  recruiterId: r.recruiter_id, teamId: r.team_id, locationId: r.location_id,
});

const ref = (id: string | null, name: string | null) => (id ? { id, name } : null);

/** Key order does not change the hash: the same body always hashes the same. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v).sort().filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

export const PLACEMENTS_ENDPOINT = "POST /api/v1/placements";

@Injectable()
export class PlacementsService {
  constructor(private readonly db: DbService, private readonly audit: AuditService) {}

  /** Field policy PL-6: rate only when rate:read covers the actor snapshot; otherwise the key is omitted. */
  present(access: UserAccess, r: PlacementRow) {
    const showRate = ownsActivity(resolveScope(access, "rate:read"), actor(r));
    return {
      id: r.id,
      status: r.status,
      placementType: r.placement_type,
      workMode: r.work_mode,
      projectCity: r.project_city,
      projectState: r.project_state,
      tentativeStart: r.tentative_start,
      isFirstPlacement: r.is_first_placement,
      ...(showRate ? { rate: r.rate === null ? null : Number(r.rate) } : {}),
      candidate: { id: r.candidate_id, name: r.candidate_name },
      recruiter: { id: r.recruiter_id, name: r.recruiter_name },
      team: ref(r.team_id, r.team_name),
      location: ref(r.location_id, r.location_name),
      client: { id: r.client_id, name: r.client_name },
      vendor: ref(r.vendor_id, r.vendor_name),
      implementationPartner: ref(r.implementation_partner_id, r.implementation_partner_name),
      submissionId: r.submission_id,
      createdAt: r.created_at,
      statusChangedAt: r.status_changed_at,
      /** Hint for the UI; authz.transition_placement checks again. */
      allowedTransitions: placementTransitions(access, actor(r), r.status),
    };
  }

  async list(user: AuthedUser, q: PlacementListQuery) {
    const scope = resolveScope(user.access, "placement:read");
    if (!scope) throw new ForbiddenException();
    const params: unknown[] = [];
    const p = (v: unknown) => { params.push(v); return `$${params.length}`; };
    const where = [activityPredicate(scope, params, "pl", "c")];
    if (q.status) where.push(`pl.status = ${p(q.status)}`);
    if (q.candidateId) where.push(`pl.candidate_id = ${p(q.candidateId)}`);
    if (q.recruiterId) where.push(`pl.recruiter_id = ${p(q.recruiterId)}`);
    if (q.from) where.push(`pl.created_at >= ${p(q.from)}::timestamptz`);
    if (q.to) where.push(`pl.created_at < ${p(q.to)}::timestamptz`);
    if (q.cursor) {
      const [k, id] = splitCursor(q.cursor);
      where.push(`(pl.created_at, pl.id) < (${fromMicros(p(k))}, ${p(id)}::uuid)`);
    }
    const sql = `${SELECT} WHERE ${where.join(" AND ")} ORDER BY pl.created_at DESC, pl.id DESC LIMIT ${p(q.limit + 1)}`;
    const rows = await this.db.withUser(user.id, async (c) => (await c.query<PlacementRow>(sql, params)).rows);
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    return {
      items: page.map((r) => this.present(user.access, r)),
      nextCursor: rows.length > q.limit && last ? `${last.k}.${last.id}` : null,
    };
  }

  private async load(c: pg.PoolClient, user: AuthedUser, id: string): Promise<PlacementRow> {
    const scope = resolveScope(user.access, "placement:read");
    if (!scope) throw new NotFoundException();
    const params: unknown[] = [id];
    const { rows } = await c.query<PlacementRow>(`${SELECT} WHERE pl.id = $1 AND ${activityPredicate(scope, params, "pl", "c")}`, params);
    if (!rows[0]) throw new NotFoundException();
    return rows[0];
  }

  /**
   * assignment:read covers the placement's actor snapshot or its candidate
   * (mirrors the assignment_read policy). Candidate ownership comes from the
   * candidate row the caller can read.
   */
  private assignmentVisible(access: UserAccess, r: PlacementRow): boolean {
    const scope = resolveScope(access, "assignment:read");
    if (!scope) return false;
    if (ownsActivity(scope, actor(r))) return true;
    return ownsCandidate(scope, {
      recruiterId: r.cand_recruiter_id, teamId: r.cand_team_id, locationId: r.cand_location_id,
      visibility: "team", marketingStatus: "",
    });
  }

  async get(user: AuthedUser, id: string) {
    return this.db.withUser(user.id, async (c) => {
      const row = await this.load(c, user, id);
      const contacts = await c.query<{ id: string; kind: string; name: string; email: string | null; phone: string | null }>(
        `SELECT id, kind, name, email, phone FROM eureka.placement_contact WHERE placement_id = $1 ORDER BY created_at, id`, [id]);
      // Paperwork checklist copied from the template at creation (migration 0035);
      // readable wherever the placement is. Document types and role keys only.
      const checklist = await c.query<{ doc_type: string; owner_role: string; required: boolean; status: string }>(
        `SELECT doc_type, owner_role, required, status FROM eureka.checklist_item
         WHERE placement_id = $1 AND kind = 'paperwork' ORDER BY position`, [id]);
      const base = {
        ...this.present(user.access, row),
        contacts: contacts.rows,
        checklist: checklist.rows.map((i) => ({ docType: i.doc_type, ownerRole: i.owner_role, required: i.required, status: i.status })),
      };
      // Field policy: the assignment key only where assignment:read covers the placement.
      if (!this.assignmentVisible(user.access, row)) return base;
      const asg = await c.query<{ assignment_no: number; start_date: string; end_date: string | null; end_reason: string | null }>(
        `SELECT assignment_no, start_date::text, end_date::text, end_reason FROM eureka.assignment WHERE placement_id = $1`, [id]);
      const a = asg.rows[0];
      return {
        ...base,
        assignment: a ? { assignmentNo: a.assignment_no, startDate: a.start_date, endDate: a.end_date, endReason: a.end_reason } : null,
      };
    });
  }

  /**
   * PL-1..PL-3, PL-5, PL-7, PL-8. Idempotency first (a repeat returns the
   * stored response), then read-before-write: 404 when the submission is not
   * visible, 403 when visible but not placeable by the caller.
   */
  async create(user: AuthedUser, body: CreatePlacement, idempotencyKey: string | undefined) {
    const key = IdempotencyKey.safeParse(idempotencyKey);
    if (!key.success) throw new BadRequestException("idempotency_key_required");
    const hash = createHash("sha256").update(canonical(body)).digest("hex");

    return this.db.withUser(user.id, async (c) => {
      const claimed = await c.query(
        `INSERT INTO eureka.idempotency_key (key, user_id, endpoint, request_hash) VALUES ($1,$2,$3,$4)
         ON CONFLICT DO NOTHING RETURNING key`, [key.data, user.id, PLACEMENTS_ENDPOINT, hash]);
      if (claimed.rowCount === 0) {
        const prior = (await c.query<{ request_hash: string; response: unknown }>(
          `SELECT request_hash, response FROM eureka.idempotency_key WHERE user_id = $1 AND endpoint = $2 AND key = $3`,
          [user.id, PLACEMENTS_ENDPOINT, key.data])).rows[0];
        if (!prior || prior.request_hash !== hash || prior.response === null) throw new ConflictException("idempotency_key_reused");
        return prior.response as { id: string; isFirstPlacement: boolean };
      }

      const readScope = resolveScope(user.access, "submission:read");
      if (!readScope) throw new NotFoundException();
      const params: unknown[] = [body.submissionId];
      const sub = (await c.query<{ recruiter_id: string; team_id: string | null; location_id: string | null; status: string; candidate_id: string }>(
        `SELECT s.recruiter_id, s.team_id, s.location_id, s.status, s.candidate_id FROM eureka.submission s
         LEFT JOIN eureka.candidate c ON c.id = s.candidate_id
         WHERE s.id = $1 AND ${activityPredicate(readScope, params)}`, params)).rows[0];
      if (!sub) throw new NotFoundException();
      if (!ownsActivity(resolveScope(user.access, "placement:create"), actor(sub))
          || !ownsActivity(resolveScope(user.access, "submission:update"), actor(sub))) {
        throw new ForbiddenException("Not permitted");
      }
      if (sub.status !== "selected") throw new UnprocessableEntityException("submission_not_selected");

      let result: { id: string; isFirstPlacement: boolean };
      let candidateChange: { from: string | null; to: string | null };
      try {
        const r = await c.query<{ placement_id: string; is_first_placement: boolean; candidate_from: string | null; candidate_to: string | null }>(
          `SELECT * FROM authz.create_placement($1, $2, $3, $4, $5, $6, $7::date, $8, $9::jsonb)`,
          [body.submissionId, body.placementType, body.rate ?? null, body.workMode, body.projectCity ?? null,
            body.projectState ?? null, body.tentativeStart, body.implementationPartnerId ?? null,
            body.contacts ? JSON.stringify(body.contacts) : null]);
        const row = r.rows[0]!;
        result = { id: row.placement_id, isFirstPlacement: row.is_first_placement };
        candidateChange = { from: row.candidate_from, to: row.candidate_to };
      } catch (err) {
        mapPlacementError(err);
      }
      await c.query(`UPDATE eureka.idempotency_key SET response = $4 WHERE user_id = $1 AND endpoint = $2 AND key = $3`,
        [user.id, PLACEMENTS_ENDPOINT, key.data, result]);
      // PL-6/PL-9: no rate and no contact details in the audit log.
      await this.audit.record(c, {
        actorId: user.id, action: "placement.created", entityType: "placement", entityId: result.id,
        changes: {
          submissionId: body.submissionId, candidateId: sub.candidate_id, placementType: body.placementType,
          workMode: body.workMode, tentativeStart: body.tentativeStart, isFirstPlacement: result.isFirstPlacement,
          contactCount: body.contacts?.length ?? 0,
        },
      });
      await this.auditCandidate(c, user, sub.candidate_id, candidateChange);
      return result;
    });
  }

  /** PL-5 side effect on the candidate, audited like a manual candidate transition. */
  private async auditCandidate(c: pg.PoolClient, user: AuthedUser, candidateId: string, ch: { from: string | null; to: string | null }) {
    if (ch.to === null) return;
    await this.audit.record(c, {
      actorId: user.id, action: "candidate.transition", entityType: "candidate", entityId: candidateId,
      changes: { from: ch.from, to: ch.to, via: "placement" },
    });
  }

  /** PL-4/PL-5. Read-before-write, then the state machine, then authz.transition_placement. */
  async changeStatus(user: AuthedUser, id: string, body: PlacementStatusChange) {
    return this.db.withUser(user.id, async (c) => {
      const row = await this.load(c, user, id);
      if (!ownsActivity(resolveScope(user.access, "placement:update"), actor(row))
          || (body.to === "bgc_failed" && !ownsActivity(resolveScope(user.access, "placement.bgc_status:update"), actor(row)))) {
        throw new ForbiddenException("Not permitted");
      }
      if (!placementTransitionAllowed(row.status, body.to)) throw new UnprocessableEntityException("invalid_transition");
      const reason = body.reason ? body.reason : null;
      if (PLACEMENT_REASON_REQUIRED.has(body.to) && reason === null) throw new UnprocessableEntityException("reason_required");
      let t: { from_status: string; to_status: string; candidate_from: string | null; candidate_to: string | null };
      try {
        t = (await c.query<typeof t>(`SELECT * FROM authz.transition_placement($1, $2, $3)`, [id, body.to, reason])).rows[0]!;
      } catch (err) {
        mapPlacementError(err);
      }
      // The function reads the status under the row lock: audit what actually changed.
      await this.audit.record(c, {
        actorId: user.id, action: "placement.status", entityType: "placement", entityId: id,
        changes: { from: t.from_status, to: t.to_status, ...(reason ? { reasonGiven: true } : {}) },
      });
      await this.auditCandidate(c, user, row.candidate_id, { from: t.candidate_from, to: t.candidate_to });
      return { id, status: t.to_status };
    });
  }
}

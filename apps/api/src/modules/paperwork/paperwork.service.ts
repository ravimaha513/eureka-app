import { ForbiddenException, Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import type pg from "pg";
import {
  BGC_REASON_REQUIRED,
  CHECKLIST_REASON_REQUIRED,
  activityVisible,
  bgcActions,
  bgcTransitionAllowed,
  checklistItemActions,
  checklistItemTransitionAllowed,
  checklistTemplateAccess,
  resolveScope,
  type ActivityRef,
  type CandidateRef,
  type PaperworkRef,
  type UserAccess,
} from "@eureka/shared";
import { AuditService } from "../../platform/audit.service.js";
import type { AuthedUser } from "../../platform/auth.guard.js";
import { DbService } from "../../platform/db.service.js";
import { activityPredicate } from "../submissions/submissions.service.js";
import { splitCursor } from "../submissions/pipeline.js";
import { mapPaperworkError } from "./paperwork.errors.js";
import type { PaperworkQueueQuery, PublishTemplate, UpdateBgc, UpdateChecklistItem } from "./paperwork.schemas.js";

/**
 * Paperwork checklist progress, background checks and checklist templates
 * (migration 0044, docs/paperwork-api.md). Reads run under the caller's RLS
 * plus the document:read predicate (design B4.4); every write goes through a
 * definer function that checks permission and scope again.
 */

/** One placement's paperwork header as the caller sees it. */
interface HeaderRow {
  placement_id: string;
  candidate_id: string;
  recruiter_id: string;
  team_id: string | null;
  location_id: string | null;
  cand_recruiter_id: string | null;
  cand_team_id: string | null;
  cand_location_id: string | null;
  cand_visibility: "team" | "all_teams" | null;
  cand_status: string | null;
  candidate_name: string | null;
  recruiter_name: string | null;
  /** NULL when the caller cannot read the placement itself (e.g. Immigration). */
  placement_status: string | null;
  placement_type: string | null;
  tentative_start: string | null;
  client_id: string | null;
  client_name: string | null;
  total: number;
  open: number;
  required_open: number;
  overdue: number;
  next_due: string | null;
  bgc_status: string;
  k: string;
}

interface ItemRow {
  id: string;
  placement_id: string;
  doc_type: string;
  owner_role: string;
  required: boolean;
  status: string;
  status_reason: string | null;
  status_changed_at: Date | null;
  assignee_id: string | null;
  assignee_name: string | null;
  due_on: string | null;
  overdue: boolean;
  notes: string | null;
  document_id: string | null;
  version: number;
  template_version: number | null;
}

const HEADER = (base: string, items: string) => `
  WITH x AS (${base}),
  agg AS (
    SELECT i.placement_id,
           count(*)::int AS total,
           count(*) FILTER (WHERE i.status IN ('pending', 'received'))::int AS open,
           count(*) FILTER (WHERE i.required AND i.status IN ('pending', 'received'))::int AS required_open,
           count(*) FILTER (WHERE i.status IN ('pending', 'received') AND i.due_on < current_date)::int AS overdue,
           min(i.due_on) FILTER (WHERE i.status IN ('pending', 'received')) AS next_due
      FROM eureka.checklist_item i
     WHERE i.kind = 'paperwork' AND i.placement_id IN (SELECT placement_id FROM x) ${items}
     GROUP BY i.placement_id)
  SELECT x.placement_id, x.candidate_id, x.recruiter_id, x.team_id, x.location_id,
         c.recruiter_id AS cand_recruiter_id, c.team_id AS cand_team_id, c.location_id AS cand_location_id,
         c.visibility AS cand_visibility, c.marketing_status AS cand_status,
         CASE WHEN pe.id IS NOT NULL THEN pe.first_name || ' ' || pe.last_name END AS candidate_name,
         ru.display_name AS recruiter_name,
         pl.status AS placement_status, pl.placement_type, pl.tentative_start::text AS tentative_start,
         cl.id AS client_id, cl.name AS client_name,
         coalesce(a.total, 0) AS total, coalesce(a.open, 0) AS open, coalesce(a.required_open, 0) AS required_open,
         coalesce(a.overdue, 0) AS overdue, a.next_due::text AS next_due,
         coalesce(b.status, 'not_started') AS bgc_status,
         (coalesce(a.next_due, date '9999-12-31') - date '1970-01-01')::text AS k
    FROM x
    LEFT JOIN agg a ON a.placement_id = x.placement_id
    LEFT JOIN eureka.bgc b ON b.placement_id = x.placement_id
    LEFT JOIN eureka.placement pl ON pl.id = x.placement_id
    LEFT JOIN eureka.client cl ON cl.id = pl.client_id
    LEFT JOIN eureka.app_user ru ON ru.id = x.recruiter_id
    LEFT JOIN eureka.candidate c ON c.id = x.candidate_id
    LEFT JOIN eureka.person pe ON pe.id = c.person_id`;

/**
 * Placements the caller may see paperwork for: readable placements plus
 * placements known through visible items or BGC rows (same snapshots, so
 * UNION keeps one row each). The document:read predicate is applied on top.
 */
const BASE = (where: (alias: string, col: string) => string) => `
  SELECT p.id AS placement_id, p.candidate_id, p.recruiter_id, p.team_id, p.location_id FROM eureka.placement p ${where("p", "id")}
  UNION SELECT i.placement_id, i.candidate_id, i.recruiter_id, i.team_id, i.location_id FROM eureka.checklist_item i ${where("i", "placement_id")}
  UNION SELECT b.placement_id, b.candidate_id, b.recruiter_id, b.team_id, b.location_id FROM eureka.bgc b ${where("b", "placement_id")}`;

const ITEM_SELECT = `
  SELECT i.id, i.placement_id, i.doc_type, i.owner_role, i.required, i.status, i.status_reason, i.status_changed_at,
         i.assignee_id, au.display_name AS assignee_name, i.due_on::text AS due_on,
         coalesce(i.status IN ('pending', 'received') AND i.due_on < current_date, false) AS overdue,
         i.notes, i.document_id, i.version, i.template_version
    FROM eureka.checklist_item i
    LEFT JOIN eureka.app_user au ON au.id = i.assignee_id`;

const candidateRef = (r: HeaderRow): CandidateRef | null =>
  r.cand_visibility === null ? null : {
    recruiterId: r.cand_recruiter_id, teamId: r.cand_team_id, locationId: r.cand_location_id,
    visibility: r.cand_visibility, marketingStatus: r.cand_status ?? "",
  };
const paperworkRef = (r: HeaderRow): PaperworkRef => ({
  recruiterId: r.recruiter_id, teamId: r.team_id, locationId: r.location_id, candidate: candidateRef(r),
});
/** For engine visibility checks; an unreadable candidate never grants ownership. */
const activityRef = (r: HeaderRow): ActivityRef => ({
  recruiterId: r.recruiter_id, teamId: r.team_id, locationId: r.location_id,
  candidate: candidateRef(r) ?? { recruiterId: null, teamId: null, locationId: null, visibility: "team", marketingStatus: "" },
});

const ref = (id: string | null, name: string | null) => (id ? { id, name } : null);

@Injectable()
export class PaperworkService {
  constructor(private readonly db: DbService, private readonly audit: AuditService) {}

  private docScope(user: AuthedUser) {
    const scope = resolveScope(user.access, "document:read");
    if (!scope) throw new ForbiddenException("Not permitted");
    return scope;
  }

  private presentHeader(r: HeaderRow) {
    return {
      placementId: r.placement_id,
      candidate: { id: r.candidate_id, name: r.candidate_name },
      recruiter: { id: r.recruiter_id, name: r.recruiter_name },
      /** null when the caller cannot read the placement record itself. */
      placement: r.placement_status === null ? null : {
        status: r.placement_status, placementType: r.placement_type, tentativeStart: r.tentative_start,
        client: ref(r.client_id, r.client_name),
      },
      checklist: { total: r.total, open: r.open, requiredOpen: r.required_open, overdue: r.overdue, nextDue: r.next_due },
      bgc: { status: r.bgc_status },
    };
  }

  /** PW-1: the work queue, ordered by the soonest open due date. */
  async queue(user: AuthedUser, q: PaperworkQueueQuery) {
    const scope = this.docScope(user);
    const params: unknown[] = [];
    const p = (v: unknown) => { params.push(v); return `$${params.length}`; };
    const itemFilters: string[] = [];
    if (q.ownerRole) itemFilters.push(`AND i.owner_role = ${p(q.ownerRole)}`);
    if (q.mine) itemFilters.push(`AND i.assignee_id = ${p(user.id)}::uuid`);
    const where = [activityPredicate(scope, params, "x", "c")];
    if (q.ownerRole || q.mine) where.push("coalesce(a.total, 0) > 0");
    if (q.view === "outstanding") {
      where.push(`(coalesce(a.open, 0) > 0 OR (coalesce(b.status, 'not_started') IN ('not_started', 'initiated', 'in_progress')
                   AND coalesce(pl.status IN ('confirmed', 'paperwork', 'bgc', 'ready'), b.status IS NOT NULL)))`);
    } else if (q.view === "overdue") {
      where.push("coalesce(a.overdue, 0) > 0");
    }
    if (q.bgcStatus) where.push(`coalesce(b.status, 'not_started') = ${p(q.bgcStatus)}`);
    if (q.placementStatus) where.push(`pl.status = ${p(q.placementStatus)}`);
    if (q.placementType) where.push(`pl.placement_type = ${p(q.placementType)}`);
    if (q.cursor) {
      const [k, id] = splitCursor(q.cursor);
      where.push(`((coalesce(a.next_due, date '9999-12-31') - date '1970-01-01'), x.placement_id) > (${p(k)}::int, ${p(id)}::uuid)`);
    }
    const sql = `${HEADER(BASE(() => ""), itemFilters.join(" "))}
      WHERE ${where.join(" AND ")}
      ORDER BY coalesce(a.next_due, date '9999-12-31'), x.placement_id LIMIT ${p(q.limit + 1)}`;
    const rows = await this.db.withUser(user.id, async (c) => (await c.query<HeaderRow>(sql, params)).rows);
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    return {
      items: page.map((r) => this.presentHeader(r)),
      nextCursor: rows.length > q.limit && last ? `${last.k}.${last.placement_id}` : null,
    };
  }

  /** The header of one placement under document:read, or 404. */
  private async header(c: pg.PoolClient, user: AuthedUser, placementId: string): Promise<HeaderRow> {
    const scope = this.docScope(user);
    const params: unknown[] = [placementId];
    const sql = `${HEADER(BASE((a, col) => `WHERE ${a}.${col} = $1`), "")} WHERE ${activityPredicate(scope, params, "x", "c")}`;
    const row = (await c.query<HeaderRow>(sql, params)).rows[0];
    if (!row) throw new NotFoundException();
    return row;
  }

  private presentItem(access: UserAccess, h: HeaderRow, i: ItemRow) {
    return {
      id: i.id,
      docType: i.doc_type,
      ownerRole: i.owner_role,
      required: i.required,
      status: i.status,
      statusReason: i.status_reason,
      statusChangedAt: i.status_changed_at,
      assignee: ref(i.assignee_id, i.assignee_name),
      dueOn: i.due_on,
      overdue: i.overdue,
      notes: i.notes,
      documentId: i.document_id,
      version: i.version,
      templateVersion: i.template_version,
      actions: checklistItemActions(access, paperworkRef(h), i.status, h.placement_status),
    };
  }

  private async bgcDetail(c: pg.PoolClient, access: UserAccess, h: HeaderRow) {
    const b = (await c.query<{
      id: string; status: string; bgc_company: string | null; initiated_on: string | null; completed_on: string | null;
      helped_by: string | null; helper_name: string | null; education_level: string | null; employment_years: number | null;
      address_years: number | null; notes: string | null; status_reason: string | null; status_changed_at: Date | null; version: number;
    }>(`SELECT b.id, b.status, b.bgc_company, b.initiated_on::text, b.completed_on::text, b.helped_by, u.display_name AS helper_name,
               b.education_level, b.employment_years, b.address_years, b.notes, b.status_reason, b.status_changed_at, b.version
          FROM eureka.bgc b LEFT JOIN eureka.app_user u ON u.id = b.helped_by WHERE b.placement_id = $1`, [h.placement_id])).rows[0];
    const history = b ? (await c.query<{ at: Date; actor_id: string | null; actor_name: string | null; from_status: string | null;
      to_status: string | null; changed: string[]; reason: string | null }>(
      `SELECT e.at, e.actor_id, u.display_name AS actor_name, e.from_status, e.to_status, e.changed, e.reason
         FROM eureka.bgc_event e LEFT JOIN eureka.app_user u ON u.id = e.actor_id
        WHERE e.bgc_id = $1 ORDER BY e.at DESC, e.id DESC LIMIT 50`, [b.id])).rows : [];
    const status = b?.status ?? "not_started";
    return {
      status,
      bgcCompany: b?.bgc_company ?? null,
      initiatedOn: b?.initiated_on ?? null,
      completedOn: b?.completed_on ?? null,
      helpedBy: ref(b?.helped_by ?? null, b?.helper_name ?? null),
      educationLevel: b?.education_level ?? null,
      employmentYears: b?.employment_years ?? null,
      addressYears: b?.address_years ?? null,
      notes: b?.notes ?? null,
      statusReason: b?.status_reason ?? null,
      statusChangedAt: b?.status_changed_at ?? null,
      /** null until the first write creates the record. */
      version: b?.version ?? null,
      history: history.map((e) => ({
        at: e.at, actor: ref(e.actor_id, e.actor_name), from: e.from_status, to: e.to_status, changed: e.changed, reason: e.reason,
      })),
      actions: bgcActions(access, paperworkRef(h), status, h.placement_status),
    };
  }

  /** PW-1: one placement's checklist and BGC (the drawer). */
  async detail(user: AuthedUser, placementId: string) {
    return this.db.withUser(user.id, async (c) => {
      const h = await this.header(c, user, placementId);
      const items = (await c.query<ItemRow>(`${ITEM_SELECT} WHERE i.placement_id = $1 AND i.kind = 'paperwork' ORDER BY i.position`,
        [placementId])).rows;
      return {
        ...this.presentHeader(h),
        items: items.map((i) => this.presentItem(user.access, h, i)),
        bgc: await this.bgcDetail(c, user.access, h),
      };
    });
  }

  /** History of one item (document:read over its placement). */
  async itemHistory(user: AuthedUser, itemId: string) {
    return this.db.withUser(user.id, async (c) => {
      const pid = (await c.query<{ placement_id: string }>(`SELECT placement_id FROM eureka.checklist_item WHERE id = $1`, [itemId])).rows[0];
      if (!pid) throw new NotFoundException();
      await this.header(c, user, pid.placement_id);
      const rows = (await c.query<{ at: Date; actor_id: string | null; actor_name: string | null; from_status: string | null;
        to_status: string | null; changed: string[]; details: Record<string, unknown>; reason: string | null }>(
        `SELECT e.at, e.actor_id, u.display_name AS actor_name, e.from_status, e.to_status, e.changed, e.details, e.reason
           FROM eureka.checklist_item_event e LEFT JOIN eureka.app_user u ON u.id = e.actor_id
          WHERE e.item_id = $1 ORDER BY e.at DESC, e.id DESC LIMIT 200`, [itemId])).rows;
      return {
        items: rows.map((e) => ({
          at: e.at, actor: ref(e.actor_id, e.actor_name), from: e.from_status, to: e.to_status,
          changed: e.changed, details: e.details, reason: e.reason,
        })),
      };
    });
  }

  /**
   * PW-2..PW-5. Read-before-write: 404 unless the item is visible (its
   * placement readable, or document:read over it); 403 for a change the
   * caller may not make; then the state machine; then the definer function.
   */
  async updateItem(user: AuthedUser, itemId: string, body: UpdateChecklistItem) {
    return this.db.withUser(user.id, async (c) => {
      const item = (await c.query<ItemRow>(`${ITEM_SELECT} WHERE i.id = $1`, [itemId])).rows[0];
      if (!item) throw new NotFoundException();
      const h = await this.headerForItem(c, user, item.placement_id);
      const acts = checklistItemActions(user.access, paperworkRef(h), item.status, h.placement_status);
      const { expectedVersion, ...changes } = body;
      const needsVerify = changes.ownerRole !== undefined || changes.assigneeId !== undefined || changes.dueOn !== undefined;
      const needsNotes = changes.notes !== undefined || changes.documentId !== undefined;
      const statusAllowed = changes.status === undefined || acts.transition.includes(changes.status)
        || !checklistItemTransitionAllowed(item.status, changes.status); // invalid edges are reported as 422 below
      if (h.placement_status !== "backout" && ((needsVerify && !acts.assign) || (needsNotes && !acts.editNotes) || !statusAllowed)) {
        throw new ForbiddenException("Not permitted");
      }
      if (changes.status !== undefined) {
        if (!checklistItemTransitionAllowed(item.status, changes.status)) throw new UnprocessableEntityException("invalid_transition");
        if (CHECKLIST_REASON_REQUIRED.has(changes.status) && !changes.reason) throw new UnprocessableEntityException("reason_required");
      }
      let r: { from_status: string; to_status: string; new_version: number; changed: string[] };
      try {
        r = (await c.query<typeof r>(`SELECT * FROM authz.update_checklist_item($1, $2::jsonb, $3)`,
          [itemId, JSON.stringify(changes), expectedVersion ?? null])).rows[0]!;
      } catch (err) {
        mapPaperworkError(err);
      }
      // Rule 5: field names, statuses, ids and dates only; never notes or reasons.
      await this.audit.record(c, {
        actorId: user.id, action: "checklist_item.update", entityType: "checklist_item", entityId: itemId,
        changes: {
          placementId: item.placement_id, docType: item.doc_type, fields: r.changed,
          ...(r.changed.includes("status") ? { from: r.from_status, to: r.to_status } : {}),
          ...(changes.reason ? { reasonGiven: true } : {}),
          ...(r.changed.includes("owner_role") ? { ownerRole: changes.ownerRole } : {}),
          ...(r.changed.includes("assignee") ? { assigneeId: changes.assigneeId } : {}),
          ...(r.changed.includes("due_on") ? { dueOn: changes.dueOn } : {}),
          ...(r.changed.includes("document") ? { documentId: changes.documentId } : {}),
        },
      });
      const fresh = (await c.query<ItemRow>(`${ITEM_SELECT} WHERE i.id = $1`, [itemId])).rows[0]!;
      return this.presentItem(user.access, h, fresh);
    });
  }

  /** The item's placement header: visible when its placement is readable or document:read covers it. */
  private async headerForItem(c: pg.PoolClient, user: AuthedUser, placementId: string): Promise<HeaderRow> {
    const params: unknown[] = [placementId];
    const row = (await c.query<HeaderRow>(`${HEADER(BASE((a, col) => `WHERE ${a}.${col} = $1`), "")}`, params)).rows[0];
    if (!row) throw new NotFoundException();
    const visible = activityVisible(resolveScope(user.access, "placement:read"), activityRef(row))
      || activityVisible(resolveScope(user.access, "document:read"), activityRef(row));
    if (!visible) throw new NotFoundException();
    return row;
  }

  /** PW-6..PW-9. 404 without document:read over the placement; 403 without bgc:update. */
  async updateBgc(user: AuthedUser, placementId: string, body: UpdateBgc) {
    return this.db.withUser(user.id, async (c) => {
      const h = await this.header(c, user, placementId);
      const current = (await c.query<{ status: string }>(`SELECT status FROM eureka.bgc WHERE placement_id = $1`, [placementId])).rows[0];
      const status = current?.status ?? "not_started";
      const acts = bgcActions(user.access, paperworkRef(h), status, h.placement_status);
      const { expectedVersion, ...changes } = body;
      if (h.placement_status !== "backout" && !acts.update) throw new ForbiddenException("Not permitted");
      if (changes.status !== undefined) {
        if (!bgcTransitionAllowed(status, changes.status)) throw new UnprocessableEntityException("invalid_transition");
        if (BGC_REASON_REQUIRED.has(changes.status) && !changes.reason) throw new UnprocessableEntityException("reason_required");
      }
      let r: { from_status: string; to_status: string; new_version: number; changed: string[]; placement_from: string | null;
        placement_to: string | null; candidate_from: string | null; candidate_to: string | null };
      try {
        r = (await c.query<typeof r>(`SELECT * FROM authz.update_bgc($1, $2::jsonb, $3)`,
          [placementId, JSON.stringify(changes), expectedVersion ?? null])).rows[0]!;
      } catch (err) {
        mapPaperworkError(err);
      }
      // Rule 5: no company, notes or reason text in the audit.
      await this.audit.record(c, {
        actorId: user.id, action: "bgc.update", entityType: "placement", entityId: placementId,
        changes: {
          fields: r.changed,
          ...(r.changed.includes("status") ? { from: r.from_status, to: r.to_status } : {}),
          ...(changes.reason ? { reasonGiven: true } : {}),
        },
      });
      if (r.placement_to !== null) {
        // Same audit as PATCH /placements/:id/status (the function's own from/to, read under the row lock).
        await this.audit.record(c, {
          actorId: user.id, action: "placement.status", entityType: "placement", entityId: placementId,
          changes: { from: r.placement_from, to: r.placement_to, reasonGiven: true, via: "bgc" },
        });
        if (r.candidate_to !== null) {
          await this.audit.record(c, {
            actorId: user.id, action: "candidate.transition", entityType: "candidate", entityId: h.candidate_id,
            changes: { from: r.candidate_from, to: r.candidate_to, via: "placement" },
          });
        }
      }
      const fresh = await this.header(c, user, placementId);
      return this.bgcDetail(c, user.access, fresh);
    });
  }

  /** PW-10: every version, newest first per kind and type. */
  async templates(user: AuthedUser) {
    const access = checklistTemplateAccess(user.access);
    if (!access.read) throw new ForbiddenException("Not permitted");
    return this.db.withUser(user.id, async (c) => {
      let rows: { kind: string; placement_type: string; version: number; items: { doc_type: string; owner_role: string; required?: boolean }[];
        published_at: Date; published_by: string | null; publisher_name: string | null }[];
      try {
        rows = (await c.query<(typeof rows)[number]>(
          `SELECT t.*, u.display_name AS publisher_name FROM authz.checklist_templates() t
             LEFT JOIN eureka.app_user u ON u.id = t.published_by`)).rows;
      } catch (err) {
        mapPaperworkError(err);
      }
      return {
        canPublish: access.publish,
        templates: rows.map((t) => ({
          kind: t.kind, placementType: t.placement_type, version: t.version, publishedAt: t.published_at,
          publishedBy: ref(t.published_by, t.publisher_name),
          items: t.items.map((i) => ({ docType: i.doc_type, ownerRole: i.owner_role, required: i.required ?? true })),
        })),
      };
    });
  }

  async publishTemplate(user: AuthedUser, body: PublishTemplate) {
    if (!checklistTemplateAccess(user.access).publish) throw new ForbiddenException("Not permitted");
    return this.db.withUser(user.id, async (c) => {
      const items = body.items.map((i) => ({ doc_type: i.docType, owner_role: i.ownerRole, ...(i.required === undefined ? {} : { required: i.required }) }));
      let version: number;
      try {
        version = (await c.query<{ v: number }>(`SELECT authz.publish_checklist_template($1, $2, $3::jsonb, $4) AS v`,
          [body.kind, body.placementType, JSON.stringify(items), body.expectedVersion])).rows[0]!.v;
      } catch (err) {
        mapPaperworkError(err);
      }
      await this.audit.record(c, {
        actorId: user.id, action: "checklist_template.publish", entityType: "checklist_template",
        changes: { kind: body.kind, placementType: body.placementType, version, itemCount: items.length },
      });
      return { kind: body.kind, placementType: body.placementType, version };
    });
  }
}

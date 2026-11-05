import {
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { DOCUMENTS_STATUSES, VISA_CATEGORIES, resolveScope, type CandidateVisibility } from "@eureka/shared";
import { AuditService } from "../../platform/audit.service.js";
import type { AuthedUser } from "../../platform/auth.guard.js";
import { DbService } from "../../platform/db.service.js";
import { toProblem } from "../../platform/errors.js";
import { RateLimiter } from "../../platform/rate-limit.js";
import { CandidatesService } from "../candidates/candidates.service.js";
import { filterSummary, hotlistMore } from "../candidates/list-filters.js";
import { toCsv } from "./csv.js";
import type pg from "pg";
import { CandidateViewFilters } from "../candidates/candidates.schemas.js";
import { HotlistFilters, type BulkPriority, type BulkStatus, type BulkVisibility, type CreateView, type UpdateView } from "./hotlist.schemas.js";
import { likeContains } from "../../platform/sql.js";

/** Row cap for a Hot List export (design A6.5 and B7: 50,000). */
export const EXPORT_ROW_CAP = 50_000;
/** Exports per user per window (design A6.5: stricter limits on export endpoints). */
export const EXPORTS_PER_WINDOW = 5;
export const EXPORT_WINDOW_MS = 10 * 60_000;
/** Bulk requests per user per minute; each request touches at most BULK_MAX records. */
export const BULK_REQUESTS_PER_MINUTE = 10;

interface ViewRow {
  id: string; name: string; filters: unknown; shared: boolean; mine: boolean; owner_name: string;
  created_at: Date; updated_at: Date;
}
/** Which list a saved view belongs to (0470). */
export type ViewList = "hotlist" | "candidates";
const VIEW_FILTERS = { hotlist: HotlistFilters, candidates: CandidateViewFilters } as const;
const VIEW_COLS = `v.id, v.name, v.filters, v.shared, v.owner_id = authz.current_user_id() AS mine, u.display_name AS owner_name,
  v.created_at, v.updated_at`;

interface ExportRow {
  id: string;
  first_name: string;
  last_name: string;
  technology: string;
  team_name: string;
  recruiter_name: string | null;
  location_name: string;
  visibility: CandidateVisibility;
  marketing_status: string;
  priority: string;
  marketing_start_date: string | null;
  technical_rating: number | null;
  phone: string | null;
  visa_category: keyof typeof VISA_CATEGORIES | null;
  documents_status: keyof typeof DOCUMENTS_STATUSES | null;
  gh_remote: boolean;
  gh_location_name: string | null;
  lead_name: string | null;
  in_person_ok: boolean | null;
}

export type BulkError = "not_found" | "forbidden" | "invalid_transition" | "placement_open" | "invalid_teams" | "failed";
export interface BulkResult { id: string; ok: boolean; error?: BulkError }

const label = (s: string) => { const t = s.replace(/_/g, " "); return t.charAt(0).toUpperCase() + t.slice(1); };

/**
 * A saved view as the client sees it. Views saved before the multi-value filters hold single
 * strings: they read back in today's shape (arrays). `mine` = the caller owns it (else a teammate
 * shared it, `owner` names who).
 */
const presentView = (list: ViewList) => (r: ViewRow) => {
  const parsed = VIEW_FILTERS[list].safeParse(r.filters);
  return {
    id: r.id, name: r.name, filters: parsed.success ? parsed.data : r.filters, shared: r.shared, mine: r.mine,
    owner: r.mine ? null : r.owner_name, createdAt: r.created_at.toISOString(), updatedAt: r.updated_at.toISOString(),
  };
};

/** Saved views, bulk actions and export for the Hot List (FR-HOT; HANDOFF task 2). */
@Injectable()
export class HotlistService {
  private readonly log = new Logger(HotlistService.name);
  private readonly exportLimiter = new RateLimiter(EXPORTS_PER_WINDOW, EXPORT_WINDOW_MS);
  private readonly bulkLimiter = new RateLimiter(BULK_REQUESTS_PER_MINUTE, 60_000);

  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly candidates: CandidatesService,
  ) {}

  // ---- saved views: RLS lets the owner change a view and teammates read a shared one (0025, 0470) ----

  async listViews(user: AuthedUser, list: ViewList) {
    const rows = await this.db.withUser(user.id, async (c) => (await c.query<ViewRow>(
      `SELECT ${VIEW_COLS} FROM eureka.hotlist_view v JOIN eureka.app_user u ON u.id = v.owner_id
        WHERE v.list = $1 ORDER BY (v.owner_id = authz.current_user_id()) DESC, lower(v.name), v.id`, [list])).rows);
    return { items: rows.map(presentView(list)) };
  }

  async createView(user: AuthedUser, list: ViewList, body: CreateView) {
    const row = await this.db.withUser(user.id, async (c) => this.mapViewErrors(async () => {
      const id = (await c.query<{ id: string }>(
        `INSERT INTO eureka.hotlist_view (list, name, filters, shared) VALUES ($1, $2, $3, $4) RETURNING id`,
        [list, body.name, body.filters, body.shared ?? false])).rows[0]!.id;
      return this.viewById(c, id);
    }));
    return presentView(list)(row!);
  }

  async updateView(user: AuthedUser, list: ViewList, id: string, body: UpdateView) {
    const row = await this.db.withUser(user.id, async (c) => this.mapViewErrors(async () => {
      // Owner only (RLS): a teammate's shared view is not found here, so 404.
      const n = (await c.query(
        `UPDATE eureka.hotlist_view SET name = coalesce($3, name), filters = coalesce($4, filters), shared = coalesce($5, shared)
          WHERE id = $1 AND list = $2 AND owner_id = authz.current_user_id()`,
        [id, list, body.name ?? null, body.filters ?? null, body.shared ?? null])).rowCount ?? 0;
      return n ? this.viewById(c, id) : undefined;
    }));
    if (!row) throw new NotFoundException();
    return presentView(list)(row);
  }

  async deleteView(user: AuthedUser, list: ViewList, id: string) {
    const n = await this.db.withUser(user.id, async (c) =>
      (await c.query(`DELETE FROM eureka.hotlist_view WHERE id = $1 AND list = $2 AND owner_id = authz.current_user_id()`, [id, list])).rowCount ?? 0);
    if (n === 0) throw new NotFoundException();
  }

  private async viewById(c: pg.PoolClient, id: string) {
    return (await c.query<ViewRow>(
      `SELECT ${VIEW_COLS} FROM eureka.hotlist_view v JOIN eureka.app_user u ON u.id = v.owner_id WHERE v.id = $1`, [id])).rows[0];
  }

  private async mapViewErrors<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      const e = err as { code?: string; constraint?: string; message?: string };
      if (e.code === "23505" && e.constraint === "hotlist_view_owner_name") throw new ConflictException("view_name_taken");
      if (e.code === "23514" && e.message === "too_many_views") throw new UnprocessableEntityException("too_many_views");
      if (e.code === "23514" && e.message === "no_team") throw new UnprocessableEntityException("no_team");
      throw err;
    }
  }

  // ---- bulk actions: the single-record operation, once per record ----

  bulkVisibility(user: AuthedUser, body: BulkVisibility) {
    return this.bulk(user, "visibility", body.visibility, body.ids, (id) => this.candidates.setVisibility(user, id, body.visibility, body.teamIds));
  }

  bulkStatus(user: AuthedUser, body: BulkStatus) {
    return this.bulk(user, "status", body.to, body.ids, (id) => this.candidates.transition(user, id, body.to));
  }

  bulkPriority(user: AuthedUser, body: BulkPriority) {
    return this.bulk(user, "priority", body.priority, body.ids, (id) => this.candidates.updateProfile(user, id, { priority: body.priority }));
  }

  /**
   * Team, recruiter and guest-house choices for the Hot List filters: names
   * only, the same staff names the list already shows. Recruiters are users
   * holding a current recruiter role.
   */
  async filterOptions(user: AuthedUser) {
    return this.db.withUser(user.id, async (c) => {
      const teams = (await c.query<{ id: string; name: string; lead: string | null }>(
        `SELECT t.id, t.name, u.display_name AS lead FROM eureka.team t LEFT JOIN eureka.app_user u ON u.id = t.lead_id
          WHERE t.deleted_at IS NULL ORDER BY lower(t.name), t.id`)).rows;
      const recruiters = (await c.query<{ id: string; name: string }>(
        `SELECT DISTINCT u.id, u.display_name AS name FROM eureka.app_user u
           JOIN eureka.user_role ur ON ur.user_id = u.id AND ur.role_key = 'recruiter' AND ur.valid @> now()
          WHERE u.status = 'active' ORDER BY 2, 1`)).rows;
      const guestHouses = (await c.query<{ id: string; name: string }>(
        `SELECT id, name FROM eureka.location WHERE kind = 'gh' ORDER BY lower(name), id`)).rows;
      return { teams, recruiters, guestHouses };
    });
  }

  /**
   * Each record goes through the same path as its single-record endpoint, in its
   * own transaction: read-before-write (404 / 403), the engine's scope check and
   * the database's own guard or definer function. One failure never stops or
   * undoes the others; every record reports its own outcome.
   */
  private async bulk(user: AuthedUser, action: "visibility" | "status" | "priority", value: string, ids: string[],
    one: (id: string) => Promise<unknown>) {
    if (!this.bulkLimiter.take(user.id)) {
      throw new HttpException("Too many bulk requests; try again in a minute", HttpStatus.TOO_MANY_REQUESTS);
    }
    const results: BulkResult[] = [];
    for (const id of ids) {
      try {
        await one(id);
        results.push({ id, ok: true });
      } catch (err) {
        const error = bulkError(err);
        if (error === "failed") this.log.error(err);
        results.push({ id, ok: false, error });
      }
    }
    const succeeded = results.filter((r) => r.ok).length;
    await this.db.withUser(user.id, (c) => this.audit.record(c, {
      actorId: user.id, action: "hotlist.bulk", entityType: "candidate",
      changes: { action, value, requested: ids.length, succeeded, failed: ids.length - succeeded },
    }));
    return { succeeded, failed: ids.length - succeeded, results };
  }

  // ---- export ----

  /**
   * CSV of the Hot List view, limited to the caller's report:export scope, capped
   * at EXPORT_ROW_CAP rows, phones always masked, audited in the same transaction
   * (who, filter summary, row count; no candidate data).
   */
  async exportCsv(user: AuthedUser, f: HotlistFilters): Promise<{ csv: string; rows: number; truncated: boolean }> {
    if (!resolveScope(user.access, "report:export")) throw new ForbiddenException();
    if (!this.exportLimiter.take(user.id)) {
      throw new HttpException("Too many exports; try again in a few minutes", HttpStatus.TOO_MANY_REQUESTS);
    }
    const rows = await this.db.withUser(user.id, async (c) => {
      await c.query(`SET LOCAL statement_timeout = '60s'`); // design N9: separate export timeout
      const r = (await c.query<ExportRow>(
        `SELECT * FROM authz.hotlist_export(NULL, NULL, NULL, $1, $2, NULL, NULL, NULL, $3, $4, $5)`,
        [f.search ? likeContains(f.search) : null, EXPORT_ROW_CAP + 1, f.resume === undefined ? null : f.resume === "yes", f.stay ?? null,
          hotlistMore(f)],
      )).rows;
      await this.audit.record(c, {
        actorId: user.id, action: "hotlist.export", entityType: "candidate",
        changes: { filters: filterSummary(f), rows: Math.min(r.length, EXPORT_ROW_CAP), truncated: r.length > EXPORT_ROW_CAP, cap: EXPORT_ROW_CAP },
      });
      return r;
    });
    const truncated = rows.length > EXPORT_ROW_CAP;
    const page = rows.slice(0, EXPORT_ROW_CAP);
    const now = Date.now();
    const csv = toCsv(
      ["Candidate", "Technology", "Status", "Visibility", "Priority", "Team", "Lead", "Recruiter", "Location", "Phone",
        "Marketing since", "Days in market", "Technical rating", "Visa", "Documents", "Stay", "In person"],
      page.map((r) => [
        `${r.first_name} ${r.last_name}`, r.technology, label(r.marketing_status),
        r.visibility === "all_teams" ? "Open to all teams" : r.visibility === "selected_teams" ? "Selected teams" : "Team only", r.priority, r.team_name,
        r.lead_name, r.recruiter_name ?? "Unassigned", r.location_name, r.phone, r.marketing_start_date,
        r.marketing_start_date ? Math.floor((now - Date.parse(r.marketing_start_date)) / 86_400_000) : null,
        r.technical_rating,
        r.visa_category ? VISA_CATEGORIES[r.visa_category] : null,
        r.documents_status ? DOCUMENTS_STATUSES[r.documents_status] : null,
        r.gh_remote ? "Remote" : r.gh_location_name ? `Guest house (${r.gh_location_name})` : null,
        r.in_person_ok === null ? null : r.in_person_ok ? "Yes" : "No",
      ]),
    );
    return { csv, rows: page.length, truncated };
  }
}

function bulkError(err: unknown): BulkError {
  if (err instanceof HttpException) {
    const detail = (err.getResponse() as { message?: string }).message;
    if (detail === "invalid_transition" || detail === "placement_open") return detail;
    // Selected teams (0240): the picks left nothing besides the candidate's own team, or name a team that is gone.
    if (detail === "teams_required" || detail === "invalid_team" || detail === "too_many_teams") return "invalid_teams";
  }
  const status = err instanceof HttpException ? err.getStatus() : toProblem(err).status;
  if (status === 404) return "not_found";
  if (status === 403) return "forbidden";
  if (status === 422) return "invalid_transition";
  return "failed";
}

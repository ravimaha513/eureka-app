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
import {
  DOCUMENTS_STATUSES, VISA_CATEGORIES, candidateTransitionAllowed, ownsCandidate, resolveScope,
  type CandidateRef, type CandidateVisibility, type Permission,
} from "@eureka/shared";
import type pg from "pg";
import { AuditService } from "../../platform/audit.service.js";
import type { AuthedUser } from "../../platform/auth.guard.js";
import { DbService } from "../../platform/db.service.js";
import { toProblem } from "../../platform/errors.js";
import { RateLimiter } from "../../platform/rate-limit.js";
import { ReportExecutor } from "../../platform/report-executor.js";
import { auditSafeProfile, moreFilters, scopePredicate } from "../candidates/candidates.service.js";
import { toCsv } from "./csv.js";
import type { BulkPriority, BulkStatus, BulkVisibility, CreateView, HotlistFilters, UpdateView } from "./hotlist.schemas.js";
import { likeContains } from "../../platform/sql.js";

/** Row cap for a Hot List export (design A6.5 and B7: 50,000). */
export const EXPORT_ROW_CAP = 50_000;
/** Exports per user per window (design A6.5: stricter limits on export endpoints). */
export const EXPORTS_PER_WINDOW = 5;
export const EXPORT_WINDOW_MS = 10 * 60_000;
/** Bulk requests per user per minute; each request touches at most BULK_MAX records. */
export const BULK_REQUESTS_PER_MINUTE = 10;

interface ViewRow { id: string; name: string; filters: HotlistFilters; created_at: Date; updated_at: Date }

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

/** What the batched read of a bulk request needs per candidate: the engine's CandidateRef and the status. */
interface BulkRow {
  id: string; recruiter_id: string | null; team_id: string | null; location_id: string | null;
  visibility: CandidateVisibility; marketing_status: string;
}
const refOf = (r: BulkRow): CandidateRef => ({
  id: r.id, recruiterId: r.recruiter_id, teamId: r.team_id, locationId: r.location_id, visibility: r.visibility, marketingStatus: r.marketing_status,
});

/*
 * Coded database errors of each bulk write, mapped as the single-record endpoint maps them
 * (CandidatesService.setVisibility / transition / updateProfile) and then reported per record.
 */
/** "Selected teams" (0240): the picks left nothing besides the candidate's own team, or name a team that is gone. */
const VISIBILITY_ERRORS: Record<string, BulkError> = { teams_required: "invalid_teams", invalid_team: "invalid_teams", too_many_teams: "invalid_teams" };
/** The placement drives the candidate until it joins or backs out (0022); team_required is a 422 (0410). */
const STATUS_ERRORS: Record<string, BulkError> = { placement_open: "placement_open", team_required: "invalid_transition" };
/** The profile's batch codes (0026), by their HTTP status: 422 / 409 / 403 / 404. */
const PRIORITY_ERRORS: Record<string, BulkError> = {
  invalid_batch: "invalid_transition", batch_exists: "failed", batch_not_allowed: "invalid_transition",
  location_not_in_scope: "forbidden", batch_not_found: "not_found", invalid_transition: "invalid_transition",
};

const label = (s: string) => { const t = s.replace(/_/g, " "); return t.charAt(0).toUpperCase() + t.slice(1); };

/** Audit-safe summary of the filters: free text (name search, technology) is recorded only as a flag (rule 5). */
export const filterSummary = (f: HotlistFilters) => ({
  status: f.status, technology: f.technology ? true : undefined, visibility: f.visibility, search: f.search ? true : undefined,
  locationId: f.locationId, visa: f.visa, documents: f.documents, resume: f.resume, stay: f.stay,
  priority: f.priority, teamId: f.teamId, recruiterId: f.recruiterId, inPerson: f.inPerson, ghLocationId: f.ghLocationId, sort: f.sort,
});


const presentView = (r: ViewRow) => ({
  id: r.id, name: r.name, filters: r.filters, createdAt: r.created_at.toISOString(), updatedAt: r.updated_at.toISOString(),
});

/** Saved views, bulk actions and export for the Hot List (FR-HOT; HANDOFF task 2). */
@Injectable()
export class HotlistService {
  private readonly log = new Logger(HotlistService.name);
  private readonly exportLimiter = new RateLimiter(EXPORTS_PER_WINDOW, EXPORT_WINDOW_MS);
  private readonly bulkLimiter = new RateLimiter(BULK_REQUESTS_PER_MINUTE, 60_000);

  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly reports: ReportExecutor,
  ) {}

  // ---- saved views: RLS keeps every row private to its owner (migration 0025) ----

  async listViews(user: AuthedUser) {
    const rows = await this.db.withUser(user.id, async (c) => (await c.query<ViewRow>(
      `SELECT id, name, filters, created_at, updated_at FROM eureka.hotlist_view ORDER BY lower(name), id`)).rows);
    return { items: rows.map(presentView) };
  }

  async createView(user: AuthedUser, body: CreateView) {
    const row = await this.db.withUser(user.id, async (c) => this.mapViewErrors(async () => (await c.query<ViewRow>(
      `INSERT INTO eureka.hotlist_view (name, filters) VALUES ($1, $2)
       RETURNING id, name, filters, created_at, updated_at`, [body.name, body.filters])).rows[0]!));
    return presentView(row);
  }

  async updateView(user: AuthedUser, id: string, body: UpdateView) {
    const row = await this.db.withUser(user.id, async (c) => this.mapViewErrors(async () => (await c.query<ViewRow>(
      `UPDATE eureka.hotlist_view SET name = coalesce($2, name), filters = coalesce($3, filters) WHERE id = $1
       RETURNING id, name, filters, created_at, updated_at`, [id, body.name ?? null, body.filters ?? null])).rows[0]));
    if (!row) throw new NotFoundException();
    return presentView(row);
  }

  async deleteView(user: AuthedUser, id: string) {
    const n = await this.db.withUser(user.id, async (c) =>
      (await c.query(`DELETE FROM eureka.hotlist_view WHERE id = $1`, [id])).rowCount ?? 0);
    if (n === 0) throw new NotFoundException();
  }

  private async mapViewErrors<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      const e = err as { code?: string; constraint?: string; message?: string };
      if (e.code === "23505" && e.constraint === "hotlist_view_owner_name") throw new ConflictException("view_name_taken");
      if (e.code === "23514" && e.message === "too_many_views") throw new UnprocessableEntityException("too_many_views");
      throw err;
    }
  }

  // ---- bulk actions: the single-record rules, one batched read, one transaction ----

  bulkVisibility(user: AuthedUser, body: BulkVisibility) {
    const teamIds = body.visibility === "selected_teams" ? body.teamIds ?? [] : [];
    return this.bulk(user, "visibility", body.visibility, body.ids, "candidate.visibility:update", VISIBILITY_ERRORS, null, async (c, row) => {
      // authz.set_candidate_visibility (0240) re-checks and replaces the "Selected teams" picks.
      await c.query(`SELECT authz.set_candidate_visibility($1, $2, $3::uuid[])`, [row.id, body.visibility, teamIds]);
      // Ids only (rule 5).
      await this.audit.record(c, { actorId: user.id, action: "candidate.visibility", entityType: "candidate", entityId: row.id,
        changes: body.visibility === "selected_teams" ? { visibility: body.visibility, teamIds } : { visibility: body.visibility } });
    });
  }

  bulkStatus(user: AuthedUser, body: BulkStatus) {
    return this.bulk(user, "status", body.to, body.ids, "candidate:update", STATUS_ERRORS,
      (row) => (candidateTransitionAllowed(row.marketing_status, body.to) ? null : "invalid_transition"),
      async (c, row) => {
        await c.query(`SELECT authz.transition_candidate($1, $2)`, [row.id, body.to]);
        await this.audit.record(c, { actorId: user.id, action: "candidate.transition", entityType: "candidate", entityId: row.id,
          changes: { from: row.marketing_status, to: body.to } });
      });
  }

  bulkPriority(user: AuthedUser, body: BulkPriority) {
    return this.bulk(user, "priority", body.priority, body.ids, "candidate:update", PRIORITY_ERRORS, null, async (c, row) => {
      // The candidate guard trigger re-checks the column per row, as on PATCH /candidates/:id.
      await c.query(`UPDATE eureka.candidate SET priority = $2 WHERE id = $1`, [row.id, body.priority]);
      await this.audit.record(c, { actorId: user.id, action: "candidate.updated", entityType: "candidate", entityId: row.id,
        changes: auditSafeProfile({ priority: body.priority }) });
    });
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
   * Each record follows the rules of its single-record endpoint (docs/candidates-api.md, Hot List
   * bulk): one read of all ids under the caller's candidate:read scope sorts them into not_found
   * (not visible), forbidden (visible, not owned under `perm`) and, for status, invalid_transition;
   * then one transaction writes the rest, each under its own savepoint, through the same definer
   * function or guarded UPDATE and with the same audit row. A record whose write fails is rolled
   * back to its savepoint (its audit row with it) and reported; one failure never stops or undoes
   * the others. One summary audit row closes the request.
   */
  private async bulk(user: AuthedUser, action: "visibility" | "status" | "priority", value: string, ids: string[], perm: Permission,
    coded: Record<string, BulkError>, check: ((row: BulkRow) => BulkError | null) | null, write: (c: pg.PoolClient, row: BulkRow) => Promise<void>) {
    if (!this.bulkLimiter.take(user.id)) {
      throw new HttpException("Too many bulk requests; try again in a minute", HttpStatus.TOO_MANY_REQUESTS);
    }
    const readScope = resolveScope(user.access, "candidate:read");
    const scope = resolveScope(user.access, perm);
    const outcome = new Map<string, BulkError | null>();
    await this.db.withUser(user.id, async (c) => {
      const rows = new Map<string, BulkRow>();
      if (readScope) {
        const params: unknown[] = [ids];
        // The same joins as the single-record read (CandidatesService.loadForWrite): a row hidden there is hidden here.
        for (const r of (await c.query<BulkRow>(
          `SELECT c.id, c.recruiter_id, c.team_id, c.location_id, c.visibility, c.marketing_status
             FROM eureka.candidate c
             JOIN eureka.person p ON p.id = c.person_id
             JOIN eureka.technology t ON t.id = c.technology_id
             JOIN eureka.location l ON l.id = c.location_id
            WHERE c.id = ANY ($1::uuid[]) AND ${scopePredicate(readScope, params)}`, params)).rows) rows.set(r.id, r);
      }
      for (const id of ids) {
        const row = rows.get(id);
        if (!row) { outcome.set(id, "not_found"); continue; }
        if (!scope || !ownsCandidate(scope, refOf(row))) { outcome.set(id, "forbidden"); continue; }
        const refused = check?.(row) ?? null;
        if (refused) { outcome.set(id, refused); continue; }
        await c.query("SAVEPOINT bulk_record");
        try {
          await write(c, row);
          await c.query("RELEASE SAVEPOINT bulk_record");
          outcome.set(id, null);
        } catch (err) {
          await c.query("ROLLBACK TO SAVEPOINT bulk_record");
          const error = bulkError(err, coded);
          if (error === "failed") this.log.error(err);
          outcome.set(id, error);
        }
      }
      const succeeded = ids.filter((id) => outcome.get(id) === null).length;
      await this.audit.record(c, {
        actorId: user.id, action: "hotlist.bulk", entityType: "candidate",
        changes: { action, value, requested: ids.length, succeeded, failed: ids.length - succeeded },
      });
    });
    const results: BulkResult[] = ids.map((id) => {
      const error = outcome.get(id) ?? null;
      return error === null ? { id, ok: true } : { id, ok: false, error };
    });
    const succeeded = results.filter((r) => r.ok).length;
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
    // design N9: separate export timeout (report executor: at most 25 s, limited concurrency, 503 + Retry-After).
    const rows = await this.reports.run(user.id, {}, async (c) => {
      const r = (await c.query<ExportRow>(
        `SELECT * FROM authz.hotlist_export($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [f.status ?? null, f.technology ?? null, f.visibility ?? null, f.search ? likeContains(f.search) : null, EXPORT_ROW_CAP + 1,
          f.locationId ?? null, f.visa ?? null, f.documents ?? null, f.resume === undefined ? null : f.resume === "yes", f.stay ?? null,
          moreFilters(f)],
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

/**
 * Per-record error of a bulk write, as the single-record endpoint answers it: its coded
 * messages first (set_candidate_visibility, transition_candidate, the profile's batch codes),
 * then the HTTP status the error maps to.
 */
function bulkError(err: unknown, coded: Record<string, BulkError>): BulkError {
  const e = err as { message?: string; code?: string };
  if (e.code !== undefined && e.message !== undefined && Object.hasOwn(coded, e.message)) return coded[e.message]!;
  const status = toProblem(err).status;
  if (status === 404) return "not_found";
  if (status === 403) return "forbidden";
  if (status === 422) return "invalid_transition";
  return "failed";
}

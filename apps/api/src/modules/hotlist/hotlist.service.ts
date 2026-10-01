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
import { resolveScope } from "@eureka/shared";
import { AuditService } from "../../platform/audit.service.js";
import type { AuthedUser } from "../../platform/auth.guard.js";
import { DbService } from "../../platform/db.service.js";
import { toProblem } from "../../platform/errors.js";
import { RateLimiter } from "../../platform/rate-limit.js";
import { CandidatesService } from "../candidates/candidates.service.js";
import { toCsv } from "./csv.js";
import type { BulkStatus, BulkVisibility, CreateView, HotlistFilters, UpdateView } from "./hotlist.schemas.js";

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
  visibility: "team" | "all_teams";
  marketing_status: string;
  priority: string;
  marketing_start_date: string | null;
  technical_rating: number | null;
  phone: string | null;
}

export type BulkError = "not_found" | "forbidden" | "invalid_transition" | "placement_open" | "failed";
export interface BulkResult { id: string; ok: boolean; error?: BulkError }

const label = (s: string) => { const t = s.replace(/_/g, " "); return t.charAt(0).toUpperCase() + t.slice(1); };

/** Audit-safe summary of the filters: free text (name search, technology) is recorded only as a flag (rule 5). */
export const filterSummary = (f: HotlistFilters) => ({
  status: f.status, technology: f.technology ? true : undefined, visibility: f.visibility, search: f.search ? true : undefined,
});

const likePattern = (s: string) => `%${s.replace(/[%_\\]/g, "\\$&")}%`;

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
    private readonly candidates: CandidatesService,
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

  // ---- bulk actions: the single-record operation, once per record ----

  bulkVisibility(user: AuthedUser, body: BulkVisibility) {
    return this.bulk(user, "visibility", body.visibility, body.ids, (id) => this.candidates.setVisibility(user, id, body.visibility));
  }

  bulkStatus(user: AuthedUser, body: BulkStatus) {
    return this.bulk(user, "status", body.to, body.ids, (id) => this.candidates.transition(user, id, body.to));
  }

  /**
   * Each record goes through the same path as its single-record endpoint, in its
   * own transaction: read-before-write (404 / 403), the engine's scope check and
   * the database's own guard or definer function. One failure never stops or
   * undoes the others; every record reports its own outcome.
   */
  private async bulk(user: AuthedUser, action: "visibility" | "status", value: string, ids: string[],
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
        `SELECT * FROM authz.hotlist_export($1, $2, $3, $4, $5)`,
        [f.status ?? null, f.technology ?? null, f.visibility ?? null, f.search ? likePattern(f.search) : null, EXPORT_ROW_CAP + 1],
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
      ["Candidate", "Technology", "Status", "Visibility", "Priority", "Team", "Recruiter", "Location", "Phone",
        "Marketing since", "Days in market", "Technical rating"],
      page.map((r) => [
        `${r.first_name} ${r.last_name}`, r.technology, label(r.marketing_status),
        r.visibility === "all_teams" ? "Open to all teams" : "Team only", r.priority, r.team_name,
        r.recruiter_name ?? "Unassigned", r.location_name, r.phone, r.marketing_start_date,
        r.marketing_start_date ? Math.floor((now - Date.parse(r.marketing_start_date)) / 86_400_000) : null,
        r.technical_rating,
      ]),
    );
    return { csv, rows: page.length, truncated };
  }
}

function bulkError(err: unknown): BulkError {
  if (err instanceof HttpException) {
    const detail = (err.getResponse() as { message?: string }).message;
    if (detail === "invalid_transition" || detail === "placement_open") return detail;
  }
  const status = err instanceof HttpException ? err.getStatus() : toProblem(err).status;
  if (status === 404) return "not_found";
  if (status === 403) return "forbidden";
  if (status === 422) return "invalid_transition";
  return "failed";
}

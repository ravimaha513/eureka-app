/**
 * Sheet import from the admin UI (docs/import.md "Upload page"), staging and
 * local only (IMPORT_UPLOAD=on; the config refuses it elsewhere). The steps the
 * CLI runs as eureka_import (stage, re-analyse, report, load) run here on a
 * separate connection as eureka_import, never as the API role; tickets, review
 * decisions, preview and sign-off stay the ImportsService calls they always
 * were. Loading can take longer than a request may (API Gateway: 30 s), so it
 * runs in the background and the page polls the batch's counts.
 */
import {
  BadRequestException, ConflictException, Controller, Get, HttpCode, Inject, Injectable, NotFoundException, Param,
  ParseUUIDPipe, Post, Query, Req, UnprocessableEntityException, type OnModuleDestroy,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { readFileSync } from "node:fs";
import pg from "pg";
import { makeHmac, todayIso, type Hmac } from "../../import/analyze.js";
import { commitBatch, type CommitResult } from "../../import/commit.js";
import { TEAM_WORKBOOK_MAPPING_PATH } from "../../import/mapping.js";
import { reconcile } from "../../import/report.js";
import { recompute, stageTexts } from "../../import/stage.js";
import { teamWorkbook, workbookTexts } from "../../import/team-workbook.js";
import { readWorkbook } from "../../import/xlsx.js";
import { CONFIG, type AppConfig } from "../../platform/config.js";
import { CurrentUser, RequirePermission, type AuthedUser } from "../../platform/auth.guard.js";
import { AuditService } from "../../platform/audit.service.js";
import { DbService } from "../../platform/db.service.js";
import { ImportsService } from "./imports.controller.js";

export interface LoadState { running: boolean; startedAt: string; finishedAt?: string; result?: CommitResult; error?: string }

@Injectable()
export class ImportUploadService implements OnModuleDestroy {
  private readonly pool: pg.Pool | null;
  private readonly hmac: Hmac | null;
  /** Background loads started by this API task (one per batch). */
  private readonly loads = new Map<string, LoadState>();

  constructor(
    @Inject(CONFIG) config: AppConfig,
    private readonly imports: ImportsService,
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {
    const on = config.IMPORT_UPLOAD === "on" && !!config.IMPORT_DATABASE_URL && !!config.IMPORT_HMAC_KEY;
    this.pool = on ? new pg.Pool({ connectionString: config.IMPORT_DATABASE_URL, max: 2 }) : null;
    this.pool?.on("connect", (c) => { void c.query("SET statement_timeout = '120s'"); });
    this.hmac = on ? makeHmac(config.IMPORT_HMAC_KEY!) : null;
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool?.end();
  }

  get enabled(): boolean {
    return this.pool !== null;
  }

  private need(): { pool: pg.Pool; hmac: Hmac } {
    if (!this.pool || !this.hmac) throw new NotFoundException("Import upload is not enabled here");
    return { pool: this.pool, hmac: this.hmac };
  }

  /** The admin must be an org admin: checked in the database by the ticket and summary functions. */
  private async requireAdmin(user: AuthedUser): Promise<void> {
    await this.db.withUser(user.id, (c) => c.query(`SELECT authz.import_require_admin()`));
  }

  async stageWorkbook(user: AuthedUser, file: Buffer, asOf: string | undefined) {
    const { pool, hmac } = this.need();
    const day = asOf ?? todayIso();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new BadRequestException("asOf must be YYYY-MM-DD");
    let wb;
    try {
      wb = teamWorkbook(await readWorkbook(file), { asOf: day });
    } catch (err) {
      throw new UnprocessableEntityException((err as Error).message);
    }
    if (wb.tabs.length === 0) {
      throw new UnprocessableEntityException("No Submissions, Interviews or Placements tabs found in this workbook");
    }
    // The signed-in admin's ticket makes them the batch's operator, as with the CLI.
    const { ticket } = await this.imports.createTicket(user);
    const r = await stageTexts(pool, workbookTexts(wb, "upload.xlsx", day),
      readFileSync(TEAM_WORKBOOK_MAPPING_PATH, "utf8"), { ticket, hmac });
    await this.db.withUser(user.id, (c) => this.audit.record(c, {
      actorId: user.id, action: "import.workbook_staged", entityType: "import_batch", entityId: r.batchId,
      changes: { asOf: day, tabs: wb.tabs.length, created: r.created },
    }));
    return {
      batchId: r.batchId, created: r.created,
      workbook: {
        tabs: wb.tabs.map((t) => ({ tab: t.name, kind: t.kind, team: t.team, rows: t.rows })),
        ignored: wb.ignored, ...wb.stats,
      },
    };
  }

  async list(user: AuthedUser) {
    const { pool } = this.need();
    await this.requireAdmin(user);
    const rows = (await pool.query<{ id: string; status: string; created_at: Date; operator: string; as_of: string | null }>(
      `SELECT b.id, b.status, b.created_at, u.email::text AS operator, b.files #>> '{submissions,source,asOf}' AS as_of
         FROM eureka.import_batch b JOIN eureka.app_user u ON u.id = b.operator_id
        WHERE b.purged_at IS NULL ORDER BY b.created_at DESC LIMIT 20`)).rows;
    return { items: rows.map((r) => ({ id: r.id, status: r.status, createdAt: r.created_at, operator: r.operator, asOf: r.as_of })) };
  }

  /** Counts per sheet and state, reasons per sheet (no personal data). */
  async report(user: AuthedUser, id: string) {
    const { pool } = this.need();
    await this.requireAdmin(user);
    try {
      const rep = await reconcile(pool, id);
      return { ...rep, load: this.loads.get(id) ?? null };
    } catch (err) {
      if (/No import batch/.test((err as Error).message)) throw new NotFoundException();
      throw err;
    }
  }

  async reanalyse(user: AuthedUser, id: string) {
    const { pool, hmac } = this.need();
    await this.requireAdmin(user);
    await recompute(pool, id, hmac);
    return this.report(user, id);
  }

  /** Starts loading an approved batch in the background; GET .../report shows progress. */
  async load(user: AuthedUser, id: string) {
    const { pool } = this.need();
    await this.requireAdmin(user);
    const st = (await pool.query<{ status: string }>(`SELECT status FROM eureka.import_batch WHERE id = $1`, [id])).rows[0];
    if (!st) throw new NotFoundException();
    if (st.status !== "approved") throw new ConflictException(`Batch is ${st.status}: approve it first`);
    if (this.loads.get(id)?.running) throw new ConflictException("This batch is already loading");
    const state: LoadState = { running: true, startedAt: new Date().toISOString() };
    this.loads.set(id, state);
    await this.db.withUser(user.id, (c) => this.audit.record(c, {
      actorId: user.id, action: "import.load_started", entityType: "import_batch", entityId: id,
    }));
    void commitBatch(pool, id, { dryRun: false })
      .then((result) => { state.result = result; })
      .catch((err: unknown) => { state.error = (err as Error).message.slice(0, 300); })
      .finally(() => { state.running = false; state.finishedAt = new Date().toISOString(); });
    return { id, loading: true };
  }
}

/** The .xlsx media type; the request body is the file itself (raw bytes, at most XLSX_LIMITS.bytes). */
export const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/**
 * Team workbook upload (org admins, access:manage; staging and local only):
 *   GET  /api/v1/import-workbooks               { enabled, items: recent batches }
 *   POST /api/v1/import-workbooks?asOf=DATE     body: the .xlsx (Content-Type XLSX_TYPE); stages a new batch
 *   GET  /api/v1/import-workbooks/:id           counts and reasons per sheet; background load state
 *   POST /api/v1/import-workbooks/:id/reanalyse after review decisions (POST /api/v1/imports/:id/decisions)
 *   POST /api/v1/import-workbooks/:id/load      after approval (POST /api/v1/imports/:id/approve); runs in the background
 */
@Controller("api/v1/import-workbooks")
@RequirePermission("access:manage")
export class ImportUploadController {
  constructor(private readonly svc: ImportUploadService) {}

  @Get()
  async list(@CurrentUser() user: AuthedUser) {
    if (!this.svc.enabled) return { enabled: false, items: [] };
    return { enabled: true, ...(await this.svc.list(user)) };
  }

  @Post()
  @HttpCode(201)
  upload(@CurrentUser() user: AuthedUser, @Req() req: FastifyRequest, @Query("asOf") asOf?: string) {
    const body = req.body;
    if (req.headers["content-type"]?.split(";")[0]?.trim() !== XLSX_TYPE || !Buffer.isBuffer(body) || body.length === 0) {
      throw new BadRequestException(`Send the workbook itself as the body, with Content-Type ${XLSX_TYPE}`);
    }
    return this.svc.stageWorkbook(user, body, asOf);
  }

  @Get(":id")
  report(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string) {
    return this.svc.report(user, id);
  }

  @Post(":id/reanalyse")
  @HttpCode(200)
  reanalyse(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string) {
    return this.svc.reanalyse(user, id);
  }

  @Post(":id/load")
  @HttpCode(202)
  load(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string) {
    return this.svc.load(user, id);
  }
}

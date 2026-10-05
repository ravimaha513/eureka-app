import { createHash, randomBytes } from "node:crypto";
import {
  Body, ConflictException, Controller, ForbiddenException, Get, HttpCode, Injectable, NotFoundException, Param,
  ParseUUIDPipe, Post, UnprocessableEntityException, type HttpException,
} from "@nestjs/common";
import type pg from "pg";
import { z } from "zod";
import { AuditService } from "../../platform/audit.service.js";
import { CurrentUser, RequirePermission, type AuthedUser } from "../../platform/auth.guard.js";
import { DbService } from "../../platform/db.service.js";

/**
 * Sheet import sign-off (docs/import.md). Everything that records a person's
 * identity in an import is an authenticated call by an org admin
 * (access:manage), checked again in the database:
 *   POST /api/v1/imports/tickets              one-time ticket; its creator becomes the batch's operator
 *   GET  /api/v1/imports/:id                  counts per sheet and state, approval and expiry
 *   GET  /api/v1/imports/:id/review           rows in review (sheet row numbers and reasons, no personal data)
 *   POST /api/v1/imports/:id/decisions        approve / reject / link one row
 *   GET  /api/v1/imports/:id/preview          what approval would load (person, owner, visibility, target
 *                                              status per row; counts per owner; verification problems; digest)
 *   POST /api/v1/imports/:id/approve          sign-off by an org admin who did not stage the batch, quoting
 *                                              the preview's digest ({ "digest": "..." })
 */
export const Decision = z.object({
  sheet: z.enum(["sales", "interviews", "placements"]),
  rowNo: z.number().int().min(2).max(1_000_000),
  action: z.enum(["approve", "reject", "link"]),
  salesRowNo: z.number().int().min(2).max(1_000_000).optional(),
}).strict().refine((d) => (d.action === "link") === (d.salesRowNo !== undefined), { message: "salesRowNo is required for link, and only for link" });
export type Decision = z.infer<typeof Decision>;
export const Approve = z.object({ digest: z.string().regex(/^[0-9a-f]{64}$/) }).strict();

const CODES: Record<string, (code: string) => HttpException> = {
  not_permitted: () => new ForbiddenException("Not permitted"),
  second_person_required: (c) => new ForbiddenException(c),
  batch_not_found: () => new NotFoundException(),
  row_not_found: () => new NotFoundException(),
  batch_closed: (c) => new ConflictException(c),
  row_committed: (c) => new ConflictException(c),
  invalid_transition: (c) => new ConflictException(c),
  needs_analysis: (c) => new ConflictException(c),
  batch_changed: (c) => new ConflictException(c),
  verification_failed: (c) => new UnprocessableEntityException(c),
  not_approvable: (c) => new UnprocessableEntityException(c),
  invalid_link: (c) => new UnprocessableEntityException(c),
  invalid_action: (c) => new UnprocessableEntityException(c),
};
function mapImportError(err: unknown): never {
  const e = err as { message?: string; code?: string };
  const make = e.message !== undefined ? CODES[e.message] : undefined;
  if (make && e.code !== undefined) throw make(e.message!);
  throw err;
}

@Injectable()
export class ImportsService {
  constructor(private readonly db: DbService, private readonly audit: AuditService) {}

  private async tx<T>(user: AuthedUser, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    try {
      return await this.db.withUser(user.id, fn);
    } catch (err) {
      mapImportError(err);
    }
  }

  async createTicket(user: AuthedUser) {
    // Prefixed so the ticket can never start with "-": base64url does about 1 time in 64, and
    // `cli.ts stage --ticket -Xyz...` then fails in parseArgs ("argument is ambiguous").
    const ticket = `imp_${randomBytes(32).toString("base64url")}`;
    const hash = createHash("sha256").update(ticket).digest("hex");
    return this.tx(user, async (c) => {
      const r = await c.query<{ e: Date }>(`SELECT authz.import_create_ticket($1) AS e`, [hash]);
      await this.audit.record(c, { actorId: user.id, action: "import.ticket_created", entityType: "import_ticket" });
      return { ticket, expiresAt: r.rows[0]!.e.toISOString() };
    });
  }

  async summary(user: AuthedUser, id: string) {
    return this.tx(user, async (c) => {
      const r = (await c.query(`SELECT * FROM authz.import_batch_summary($1)`, [id])).rows[0];
      return {
        id, status: r.status, operatorId: r.operator_id, approvedBy: r.approved_by, approvedAt: r.approved_at,
        approvalExpiresAt: r.approval_expires_at, analysedAt: r.analysed_at, purgedAt: r.purged_at,
        counts: r.counts, pendingDecisions: r.pending_decisions,
      };
    });
  }

  async review(user: AuthedUser, id: string) {
    return this.tx(user, async (c) => ({
      items: (await c.query(`SELECT * FROM authz.import_review_rows($1)`, [id])).rows.map((r) => ({
        sheet: r.sheet, rowNo: r.row_no, state: r.state, reasons: r.reasons, salesRow: r.sales_row,
        approvable: r.approvable, commitError: r.commit_error,
      })),
    }));
  }

  async decide(user: AuthedUser, id: string, d: Decision) {
    return this.tx(user, async (c) => {
      await c.query(`SELECT authz.import_decide($1, $2, $3, $4, $5)`, [id, d.sheet, d.rowNo, d.action, d.salesRowNo ?? null]);
      await this.audit.record(c, {
        actorId: user.id, action: "import.row_decided", entityType: "import_batch", entityId: id,
        changes: { sheet: d.sheet, rowNo: d.rowNo, action: d.action, ...(d.salesRowNo ? { salesRowNo: d.salesRowNo } : {}) },
      });
      return { sheet: d.sheet, rowNo: d.rowNo, action: d.action };
    });
  }

  /** Personal data (names, owner emails) for org admins only, the people who sign off. */
  async preview(user: AuthedUser, id: string) {
    return this.tx(user, async (c) => {
      const p = (await c.query<{ p: unknown }>(`SELECT authz.import_load_preview($1) AS p`, [id])).rows[0]!.p;
      await this.audit.record(c, { actorId: user.id, action: "import.preview_read", entityType: "import_batch", entityId: id });
      return p;
    });
  }

  async approve(user: AuthedUser, id: string, digest: string) {
    return this.tx(user, async (c) => {
      await c.query(`SELECT authz.import_approve_batch($1, $2)`, [id, digest]);
      const s = (await c.query(`SELECT counts, approval_expires_at FROM authz.import_batch_summary($1)`, [id])).rows[0];
      await this.audit.record(c, { actorId: user.id, action: "import.batch_approved", entityType: "import_batch", entityId: id, changes: { counts: s.counts } });
      return { id, status: "approved", approvalExpiresAt: s.approval_expires_at };
    });
  }
}

@Controller("api/v1/imports")
@RequirePermission("access:manage")
export class ImportsController {
  constructor(private readonly svc: ImportsService) {}

  @Post("tickets")
  createTicket(@CurrentUser() user: AuthedUser) {
    return this.svc.createTicket(user);
  }

  @Get(":id")
  summary(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string) {
    return this.svc.summary(user, id);
  }

  @Get(":id/review")
  review(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string) {
    return this.svc.review(user, id);
  }

  @Post(":id/decisions")
  @HttpCode(200)
  decide(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.svc.decide(user, id, Decision.parse(body));
  }

  @Get(":id/preview")
  preview(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string) {
    return this.svc.preview(user, id);
  }

  @Post(":id/approve")
  @HttpCode(200)
  approve(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.svc.approve(user, id, Approve.parse(body).digest);
  }
}

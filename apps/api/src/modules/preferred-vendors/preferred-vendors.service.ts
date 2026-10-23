import { ForbiddenException, HttpException, HttpStatus, Injectable, NotFoundException } from "@nestjs/common";
import { can } from "@eureka/shared";
import { z } from "zod";
import type { AuthedUser } from "../../platform/auth.guard.js";
import { AuditService } from "../../platform/audit.service.js";
import { DbService } from "../../platform/db.service.js";
import { mapPvError } from "../pipeline-report/pipeline-report.errors.js";
import { likeContains } from "../../platform/sql.js";

/** docs/pipeline-vendors-api.md PV-9..PV-12. Strict schemas (rule 4). */
const Text = (max: number) => z.string().trim().min(1).max(max).regex(/^[^\u0000-\u001f\u007f]*$/, "no control characters");
const VendorFields = {
  vendorName: Text(200),
  vendorId: z.string().uuid().nullable().optional(),
  contactName: Text(120).nullable().optional(),
  contactEmail: z.string().trim().toLowerCase().email().max(254).nullable().optional(),
  contactPhone: z.string().trim().regex(/^\+[1-9][0-9]{7,14}$/, "E.164 phone, e.g. +14695550100").nullable().optional(),
  technologyId: z.string().uuid().nullable().optional(),
  clients: Text(500).nullable().optional(),
  notes: z.string().trim().max(2000).regex(/^[^\u0000-\u0009\u000b-\u001f\u007f]*$/, "no control characters").nullable().optional(),
};
export const CreatePreferredVendor = z.object(VendorFields).strict();
export type CreatePreferredVendor = z.infer<typeof CreatePreferredVendor>;
/** Full replacement of the editable fields (If-Match: the rowVersion the client saw). */
export const UpdatePreferredVendor = CreatePreferredVendor;

export const PreferredVendorQuery = z.object({
  /** Only one owner's entries (must be visible to the caller; otherwise the list is empty). */
  ownerId: z.string().uuid().optional(),
  technologyId: z.string().uuid().optional(),
  /** Matches vendor name, contact name or clients (case-insensitive substring). */
  q: z.string().trim().min(1).max(100).optional(),
  archived: z.enum(["true", "false"]).transform((v) => v === "true").default("false"),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  offset: z.coerce.number().int().min(0).max(10_000).default(0),
}).strict();
export type PreferredVendorQuery = z.infer<typeof PreferredVendorQuery>;

interface Row {
  id: string; owner_id: string; owner_name: string | null; vendor_name: string; vendor_id: string | null; vendor: string | null;
  contact_name: string | null; contact_email: string | null; contact_phone: string | null;
  technology_id: string | null; technology: string | null; clients: string | null; notes: string | null;
  archived: boolean; created_at: Date; updated_at: Date; row_version: number; total?: number;
}

const SELECT = `SELECT pv.id, pv.owner_id, u.display_name AS owner_name, pv.vendor_name, pv.vendor_id, v.name AS vendor,
    pv.contact_name, pv.contact_email, pv.contact_phone, pv.technology_id, t.name AS technology, pv.clients, pv.notes,
    pv.archived, pv.created_at, pv.updated_at, pv.row_version
  FROM eureka.preferred_vendor pv
  LEFT JOIN eureka.app_user u ON u.id = pv.owner_id
  LEFT JOIN eureka.vendor v ON v.id = pv.vendor_id
  LEFT JOIN eureka.technology t ON t.id = pv.technology_id`;

/** The ILIKE pattern of a literal substring. */

@Injectable()
export class PreferredVendorsService {
  constructor(private readonly db: DbService, private readonly audit: AuditService) {}

  private present(user: AuthedUser, r: Row) {
    const mine = r.owner_id === user.id;
    return {
      id: r.id,
      owner: { id: r.owner_id, name: r.owner_name },
      vendorName: r.vendor_name,
      vendor: r.vendor_id ? { id: r.vendor_id, name: r.vendor } : null,
      contactName: r.contact_name, contactEmail: r.contact_email, contactPhone: r.contact_phone,
      technology: r.technology_id ? { id: r.technology_id, name: r.technology } : null,
      clients: r.clients, notes: r.notes, archived: r.archived,
      createdAt: r.created_at.toISOString(), updatedAt: r.updated_at.toISOString(), rowVersion: r.row_version,
      actions: { edit: mine && !r.archived && can(user.access, "vendor.preferred:create"), archive: mine && !r.archived && can(user.access, "vendor.preferred:create") },
    };
  }

  private requireAccess(user: AuthedUser) {
    if (!can(user.access, "vendor.preferred:create") && !can(user.access, "vendor.preferred:read")) {
      throw new ForbiddenException("Not permitted");
    }
  }

  /** RLS decides visibility: the owner and their superiors (migration 0172). */
  async list(user: AuthedUser, q: PreferredVendorQuery) {
    this.requireAccess(user);
    return this.db.withUser(user.id, async (c) => {
      const params: unknown[] = [q.archived];
      const where = ["pv.archived = $1"];
      const p = (v: unknown) => { params.push(v); return `$${params.length}`; };
      if (q.ownerId) where.push(`pv.owner_id = ${p(q.ownerId)}::uuid`);
      if (q.technologyId) where.push(`pv.technology_id = ${p(q.technologyId)}::uuid`);
      if (q.q) {
        const pat = p(likeContains(q.q));
        where.push(`(pv.vendor_name ILIKE ${pat} OR pv.contact_name ILIKE ${pat} OR pv.clients ILIKE ${pat})`);
      }
      const rows = (await c.query<Row>(`${SELECT.replace("pv.row_version", "pv.row_version, count(*) OVER ()::int AS total")}
        WHERE ${where.join(" AND ")} ORDER BY lower(pv.vendor_name), pv.id LIMIT ${p(q.limit)} OFFSET ${p(q.offset)}`, params)).rows;
      // Owners the caller can filter by: every owner of a visible entry.
      const owners = (await c.query<{ id: string; name: string | null }>(`SELECT DISTINCT pv.owner_id AS id, u.display_name AS name
        FROM eureka.preferred_vendor pv LEFT JOIN eureka.app_user u ON u.id = pv.owner_id ORDER BY 2, 1`)).rows;
      return {
        items: rows.map((r) => this.present(user, r)),
        total: rows[0]?.total ?? 0,
        owners,
        actions: { create: can(user.access, "vendor.preferred:create") },
      };
    });
  }

  async get(user: AuthedUser, id: string) {
    this.requireAccess(user);
    return this.db.withUser(user.id, async (c) => {
      const r = (await c.query<Row>(`${SELECT} WHERE pv.id = $1`, [id])).rows[0];
      if (!r) throw new NotFoundException();
      return this.present(user, r);
    });
  }

  async create(user: AuthedUser, body: CreatePreferredVendor) {
    if (!can(user.access, "vendor.preferred:create")) throw new ForbiddenException("Not permitted");
    return this.db.withUser(user.id, async (c) => {
      const id = (await c.query<{ id: string }>(`SELECT authz.preferred_vendor_create($1, $2, $3, $4, $5, $6, $7, $8) AS id`, [
        body.vendorName, body.vendorId ?? null, body.contactName ?? null, body.contactEmail ?? null, body.contactPhone ?? null,
        body.technologyId ?? null, body.clients ?? null, body.notes || null,
      ]).catch(mapPvError)).rows[0]!.id;
      // Ids and which fields are set only: never names, contacts or notes (rule 5).
      await this.audit.record(c, {
        actorId: user.id, action: "preferred_vendor.created", entityType: "preferred_vendor", entityId: id,
        changes: { vendorId: body.vendorId ?? null, technologyId: body.technologyId ?? null, fields: Object.keys(body).sort() },
      });
      return this.present(user, (await c.query<Row>(`${SELECT} WHERE pv.id = $1`, [id])).rows[0]!);
    });
  }

  /** Read-before-write: 404 when not visible, 403 when visible but not the caller's. */
  private async loadOwned(c: import("pg").PoolClient, user: AuthedUser, id: string): Promise<Row> {
    const r = (await c.query<Row>(`${SELECT} WHERE pv.id = $1`, [id])).rows[0];
    if (!r) throw new NotFoundException();
    if (r.owner_id !== user.id || !can(user.access, "vendor.preferred:create")) throw new ForbiddenException("Not permitted");
    return r;
  }

  async update(user: AuthedUser, id: string, expected: number | null, parse: () => CreatePreferredVendor) {
    this.requireAccess(user);
    return this.db.withUser(user.id, async (c) => {
      const cur = await this.loadOwned(c, user, id);
      const body = parse();
      if (expected === null) throw new HttpException("if_match_required", HttpStatus.PRECONDITION_REQUIRED);
      if (expected !== cur.row_version) throw new HttpException("stale", HttpStatus.PRECONDITION_FAILED);
      await c.query(`SELECT authz.preferred_vendor_update($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`, [
        id, expected, body.vendorName, body.vendorId ?? null, body.contactName ?? null, body.contactEmail ?? null,
        body.contactPhone ?? null, body.technologyId ?? null, body.clients ?? null, body.notes || null,
      ]).catch(mapPvError);
      await this.audit.record(c, {
        actorId: user.id, action: "preferred_vendor.updated", entityType: "preferred_vendor", entityId: id,
        changes: { fields: Object.keys(body).sort() },
      });
      return this.present(user, (await c.query<Row>(`${SELECT} WHERE pv.id = $1`, [id])).rows[0]!);
    });
  }

  async archive(user: AuthedUser, id: string) {
    this.requireAccess(user);
    return this.db.withUser(user.id, async (c) => {
      const cur = await this.loadOwned(c, user, id);
      await c.query(`SELECT authz.preferred_vendor_archive($1)`, [id]).catch(mapPvError);
      if (!cur.archived) {
        await this.audit.record(c, { actorId: user.id, action: "preferred_vendor.archived", entityType: "preferred_vendor", entityId: id });
      }
    });
  }
}

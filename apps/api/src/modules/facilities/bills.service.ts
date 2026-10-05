import {
  ConflictException, ForbiddenException, HttpException, HttpStatus, Inject, Injectable, NotFoundException, UnprocessableEntityException,
} from "@nestjs/common";
import type pg from "pg";
import { DOCUMENT_CONTENT_TYPES, type DocumentContentType } from "@eureka/shared";
import { AuditService } from "../../platform/audit.service.js";
import type { AuthedUser } from "../../platform/auth.guard.js";
import { DbService } from "../../platform/db.service.js";
import { RateLimiter } from "../../platform/rate-limit.js";
import { documentQuarantineKey, documentStoredKey } from "../../platform/storage/content.js";
import { DOCUMENT_STORAGE, type DocumentStorage } from "../../platform/storage/document-storage.js";
import { toCsv } from "../hotlist/csv.js";
import {
  DOCUMENT_DOWNLOADS_PER_MINUTE, DOCUMENT_DOWNLOAD_TTL_SECONDS, DOCUMENT_UPLOADS_PER_MINUTE, DOCUMENT_UPLOAD_TTL_SECONDS,
} from "../documents/documents.service.js";
import {
  EXPORTS_PER_WINDOW, EXPORT_ROW_CAP, EXPORT_WINDOW_MS, KINDS, covers, decodeCursor, encodeCursor, mapDbError, monthStartBefore,
  monthEndOf, monthsBetween, needle, requireVersion, todayIn, type OwnerKind,
} from "./facilities.common.js";
import type {
  BillCreate, BillExportQuery, BillListQuery, BillStatus, BillUpdate, SummaryQuery, UtilityType,
} from "./facilities.schemas.js";
import { OwnersService } from "./owners.service.js";

/** Longest summary period (inclusive months). */
export const SUMMARY_MAX_MONTHS = 60;

interface BillRow {
  id: string;
  utility_id: string;
  utility_type: UtilityType;
  service_provider: string;
  owner_kind: OwnerKind;
  owner_id: string;
  location_id: string;
  payment_method: string;
  amount: string;
  billing_start: string;
  billing_end: string;
  due_date: string;
  paid_on: string | null;
  status: BillStatus;
  voided: boolean;
  invoice_document_id: string | null;
  invoice_status: string | null;
  invoice_content_type: DocumentContentType | null;
  row_version: number;
}

/**
 * Status is derived, never stored: paid (paid_on set), overdue (due before
 * today, unpaid), due. "Today" is the calendar day in the owner's location
 * time zone (eureka.location.timezone).
 */
const SELECT = `SELECT b.id, b.utility_id, u.utility_type, u.service_provider,
    CASE WHEN u.company_id IS NOT NULL THEN 'company' ELSE 'facility' END AS owner_kind,
    coalesce(u.company_id, u.facility_id) AS owner_id, coalesce(c.location_id, f.location_id) AS location_id,
    b.payment_method, b.amount::text AS amount, b.billing_start::text AS billing_start, b.billing_end::text AS billing_end,
    b.due_date::text AS due_date, b.paid_on::text AS paid_on,
    CASE WHEN b.paid_on IS NOT NULL THEN 'paid'
         WHEN b.due_date < (now() AT TIME ZONE l.timezone)::date THEN 'overdue' ELSE 'due' END AS status,
    (b.voided_at IS NOT NULL) AS voided, inv.id AS invoice_document_id, inv.status AS invoice_status, inv.content_type AS invoice_content_type,
    b.row_version
  FROM eureka.utility_bill b
  JOIN eureka.utility u ON u.id = b.utility_id
  LEFT JOIN eureka.company c ON c.id = u.company_id
  LEFT JOIN eureka.facility f ON f.id = u.facility_id
  JOIN eureka.location l ON l.id = coalesce(c.location_id, f.location_id)
  -- The current invoice: the newest clean upload, else the newest upload (to show its scan state).
  LEFT JOIN LATERAL (
    SELECT d.id, fo.status, fo.content_type FROM eureka.document d JOIN eureka.file_object fo ON fo.id = d.file_id
     WHERE d.bill_id = b.id
     ORDER BY (fo.status = 'clean') DESC, d.created_at DESC, d.id DESC LIMIT 1) inv ON true`;

/** Download name of an invoice: the billing start and a short id, never an uploaded file name. */
const invoiceName = (r: Pick<BillRow, "billing_start" | "invoice_document_id" | "invoice_content_type">) =>
  `invoice-${r.billing_start}-${r.invoice_document_id!.slice(0, 8)}.${DOCUMENT_CONTENT_TYPES[r.invoice_content_type ?? "application/pdf"].ext}`;

const present = (r: BillRow) => ({
  id: r.id,
  utility: { id: r.utility_id, utilityType: r.utility_type, serviceProvider: r.service_provider },
  paymentMethod: r.payment_method,
  amount: r.amount,
  billingStart: r.billing_start,
  billingEnd: r.billing_end,
  dueDate: r.due_date,
  paidOn: r.paid_on,
  status: r.status,
  /** The current invoice and its scan state (pending, clean, infected, failed, rejected, expired). */
  invoice: r.invoice_document_id && r.invoice_status
    ? { documentId: r.invoice_document_id, fileName: invoiceName(r), status: r.invoice_status }
    : null,
  rowVersion: r.row_version,
});

const FIELDS = ["utilityId", "paymentMethod", "amount", "billingStart", "billingEnd", "dueDate", "paidOn"] as const;
const COLUMN = {
  utilityId: "utility_id", paymentMethod: "payment_method", amount: "amount", billingStart: "billing_start",
  billingEnd: "billing_end", dueDate: "due_date", paidOn: "paid_on",
} as const satisfies Record<(typeof FIELDS)[number], keyof BillRow>;

/**
 * Utility bills of a company or facility (docs/facilities-api.md, migration
 * 0054). Read: bill:read over the owner's location (RLS utility_bill_read,
 * which also needs the utility and the owner readable); writes: bill:manage
 * through definer functions. Voided bills are kept but left out of every list,
 * export and total. Invoices reuse the document pipeline of migration 0043
 * (presigned POST to quarantine, malware scan by the document-scan job,
 * download links for clean files only, every link in the access log).
 */
@Injectable()
export class BillsService {
  private readonly uploadLimiter = new RateLimiter(DOCUMENT_UPLOADS_PER_MINUTE, 60_000);
  private readonly downloadLimiter = new RateLimiter(DOCUMENT_DOWNLOADS_PER_MINUTE, 60_000);
  private readonly exportLimiter = new RateLimiter(EXPORTS_PER_WINDOW, EXPORT_WINDOW_MS);

  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly owners: OwnersService,
    @Inject(DOCUMENT_STORAGE) private readonly storage: DocumentStorage,
  ) {}

  /** The bill as the caller sees it (RLS); 404 when not visible. */
  private async load(c: pg.PoolClient, id: string): Promise<BillRow> {
    const r = (await c.query<BillRow>(`${SELECT} WHERE b.id = $1`, [id])).rows[0];
    if (!r) throw new NotFoundException();
    return r;
  }

  /** load() plus bill:manage over the location (403) and not voided (409). */
  private async loadManaged(c: pg.PoolClient, user: AuthedUser, id: string): Promise<BillRow> {
    const r = await this.load(c, id);
    if (!covers(user.access, "bill:manage", r.location_id)) throw new ForbiddenException("Not permitted");
    if (r.voided) throw new ConflictException("bill_voided");
    return r;
  }

  /** The owner readable (404) and bill:read over it (404, as RLS would hide its bills). */
  private async owner(c: pg.PoolClient, user: AuthedUser, kind: OwnerKind, ownerId: string) {
    const o = await this.owners.load(c, kind, ownerId);
    if (!covers(user.access, "bill:read", o.location_id) || !covers(user.access, "utility:read", o.location_id)) throw new NotFoundException();
    return o;
  }

  private filters(kind: OwnerKind, ownerId: string, q: BillExportQuery, params: unknown[]): string[] {
    const p = (v: unknown) => { params.push(v); return `$${params.length}`; };
    const where = [`u.${KINDS[kind].fk} = ${p(ownerId)}`, "b.voided_at IS NULL"];
    if (q.from) where.push(`b.billing_start >= ${p(q.from)}::date`);
    if (q.to) where.push(`b.billing_start <= ${p(q.to)}::date`);
    if (q.utilityId) where.push(`b.utility_id = ${p(q.utilityId)}::uuid`);
    if (q.q) {
      const n = p(needle(q.q));
      where.push(`(strpos(u.utility_type, ${n}) > 0 OR strpos(lower(u.service_provider), ${n}) > 0 OR strpos(b.payment_method, ${n}) > 0)`);
    }
    return where;
  }

  async list(user: AuthedUser, kind: OwnerKind, ownerId: string, q: BillListQuery) {
    return this.db.withUser(user.id, async (c) => {
      const o = await this.owner(c, user, kind, ownerId);
      const params: unknown[] = [];
      const where = this.filters(kind, ownerId, q, params);
      const p = (v: unknown) => { params.push(v); return `$${params.length}`; };
      const cur = decodeCursor(q.cursor, 2);
      if (cur) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(cur[0]!)) throw new UnprocessableEntityException("invalid_cursor");
        where.push(`(b.billing_start, b.id) < (${p(cur[0])}::date, ${p(cur[1])}::uuid)`);
      }
      const statusFilter = q.status ? `WHERE x.status = ${p(q.status)}` : "";
      const { rows } = await c.query<BillRow>(
        `SELECT * FROM (${SELECT} WHERE ${where.join(" AND ")}) x ${statusFilter}
          ORDER BY x.billing_start DESC, x.id DESC LIMIT ${p(q.limit + 1)}`, params).catch((e: { code?: string }) => {
        if (e.code === "22P02" || e.code === "22007" || e.code === "22008") throw new UnprocessableEntityException("invalid_cursor");
        throw e;
      });
      const page = rows.slice(0, q.limit);
      const last = page[page.length - 1];
      return {
        items: page.map(present),
        nextCursor: rows.length > q.limit && last ? encodeCursor([last.billing_start, last.id]) : null,
        actions: { manage: covers(user.access, "bill:manage", o.location_id) },
      };
    });
  }

  /** The body is parsed after the scope check, so callers without rights get 403/404, not 422. */
  async create(user: AuthedUser, kind: OwnerKind, ownerId: string, parse: () => BillCreate) {
    return this.db.withUser(user.id, async (c) => {
      const o = await this.owner(c, user, kind, ownerId);
      if (!covers(user.access, "bill:manage", o.location_id)) throw new ForbiddenException("Not permitted");
      const b = parse();
      const id = (await c.query<{ id: string }>(`SELECT authz.bill_create($1, $2, $3, $4, $5::numeric, $6::date, $7::date, $8::date, $9::date) AS id`,
        [kind, ownerId, b.utilityId, b.paymentMethod, b.amount, b.billingStart, b.billingEnd, b.dueDate, b.paidOn ?? null])
        .catch(mapDbError)).rows[0]!.id;
      // Rule 5: ids, codes and dates; never the amount.
      await this.audit.record(c, {
        actorId: user.id, action: "bill.created", entityType: "utility_bill", entityId: id,
        changes: {
          ownerKind: kind, ownerId, utilityId: b.utilityId, paymentMethod: b.paymentMethod, billingStart: b.billingStart,
          billingEnd: b.billingEnd, dueDate: b.dueDate, paidOn: b.paidOn ?? null,
        },
      });
      return present(await this.load(c, id));
    });
  }

  async update(user: AuthedUser, id: string, expectedVersion: number | null, parse: () => BillUpdate) {
    return this.db.withUser(user.id, async (c) => {
      const cur = await this.loadManaged(c, user, id);
      const body = parse();
      requireVersion(expectedVersion, cur.row_version);
      const next = Object.fromEntries(FIELDS.map((f) => [f, body[f] !== undefined ? body[f] : cur[COLUMN[f]]])) as Record<(typeof FIELDS)[number], string | null>;
      if (next.billingEnd! < next.billingStart!) throw new UnprocessableEntityException("billingEnd must not be before billingStart");
      const version = (await c.query<{ v: number }>(
        `SELECT authz.bill_update($1, $2, $3, $4, $5::numeric, $6::date, $7::date, $8::date, $9::date) AS v`,
        [id, expectedVersion, next.utilityId, next.paymentMethod, next.amount, next.billingStart, next.billingEnd, next.dueDate, next.paidOn])
        .catch(mapDbError)).rows[0]!.v;
      const changed = FIELDS.filter((f) => body[f] !== undefined && (body[f] ?? null) !== cur[COLUMN[f]]);
      await this.audit.record(c, {
        actorId: user.id, action: "bill.updated", entityType: "utility_bill", entityId: id,
        changes: {
          changed, rowVersion: version,
          ...Object.fromEntries(changed.filter((f) => f !== "amount").map((f) => [f, next[f]])),
        },
      });
      return present(await this.load(c, id));
    });
  }

  /** "Delete" in the UI. The reason is stored on the bill, never in the audit log (rule 5). */
  async void(user: AuthedUser, id: string, parse: () => { reason: string }) {
    return this.db.withUser(user.id, async (c) => {
      await this.loadManaged(c, user, id);
      const { reason } = parse();
      const version = (await c.query<{ v: number }>(`SELECT authz.bill_void($1, $2) AS v`, [id, reason]).catch(mapDbError)).rows[0]!.v;
      await this.audit.record(c, { actorId: user.id, action: "bill.voided", entityType: "utility_bill", entityId: id, changes: { reasonGiven: true, rowVersion: version } });
      return { id, voided: true, rowVersion: version };
    });
  }

  /** Starts an invoice upload: a presigned POST into quarantine (as POST /candidates/:id/documents). */
  async requestInvoiceUpload(user: AuthedUser, id: string, parse: () => { contentType: DocumentContentType; size: number }) {
    return this.db.withUser(user.id, async (c) => {
      await this.loadManaged(c, user, id);
      const body = parse();
      if (!this.uploadLimiter.take(user.id)) {
        throw new HttpException("Too many uploads; try again in a minute", HttpStatus.TOO_MANY_REQUESTS);
      }
      const row = (await c.query<{ document_id: string; file_id: string }>(
        `SELECT document_id, file_id FROM authz.bill_invoice_upload($1, $2, $3)`, [id, body.contentType, body.size]).catch(mapDbError)).rows[0]!;
      await this.audit.record(c, {
        actorId: user.id, action: "bill.invoice_upload_requested", entityType: "utility_bill", entityId: id,
        changes: { documentId: row.document_id, fileId: row.file_id, contentType: body.contentType, sizeBytes: body.size },
      });
      const upload = await this.storage.presignUpload({
        key: documentQuarantineKey(row.file_id), contentType: body.contentType, size: body.size, expiresSeconds: DOCUMENT_UPLOAD_TTL_SECONDS,
      });
      return { id: row.document_id, documentId: row.document_id, fileId: row.file_id, classification: "internal" as const, status: "pending" as const, upload };
    });
  }

  /** A 60-second download link for the bill's current invoice once it scanned clean; logged and audited. */
  async invoiceDownload(user: AuthedUser, id: string) {
    const out = await this.db.withUser(user.id, async (c) => {
      const b = await this.load(c, id);
      if (b.voided) throw new NotFoundException();
      if (!this.downloadLimiter.take(user.id)) {
        throw new HttpException("Too many downloads; try again in a minute", HttpStatus.TOO_MANY_REQUESTS);
      }
      const r = (await c.query<{ outcome: string; document_id: string | null; file_id: string | null; content_type: DocumentContentType | null }>(
        `SELECT outcome, document_id, file_id, content_type FROM authz.bill_invoice_download($1)`, [id]).catch(mapDbError)).rows[0]!;
      if (r.outcome !== "ok" || !r.file_id || !r.document_id || !r.content_type) return { outcome: r.outcome } as const;
      const ttl = DOCUMENT_DOWNLOAD_TTL_SECONDS.internal;
      const url = await this.storage.presignDownload({
        key: documentStoredKey(r.file_id, "internal"), contentType: r.content_type,
        fileName: invoiceName({ billing_start: b.billing_start, invoice_document_id: r.document_id, invoice_content_type: r.content_type }),
        expiresSeconds: ttl,
      });
      return { outcome: "ok", url, expiresAt: new Date(Date.now() + ttl * 1000).toISOString() } as const;
    });
    if (out.outcome === "none") throw new NotFoundException("no_invoice");
    if (out.outcome !== "ok") throw new ConflictException("not_available");
    return { url: out.url, expiresAt: out.expiresAt };
  }

  /**
   * KPI and chart data over non-voided bills by billing_start, for every
   * company (or facility) in the caller's scope. Amounts are strings with 2
   * decimals. Default period: the 12 whole calendar months ending with the
   * current month in `tz` (default UTC), up to its last day. averagePerMonth = totalAmount / months in the
   * period (inclusive calendar months).
   */
  async summary(user: AuthedUser, kind: OwnerKind, q: SummaryQuery) {
    const today = todayIn(q.tz ?? "UTC");
    // Without `to`, the period ends with the last day of the current month (or of from's month, if later).
    const to = q.to ?? monthEndOf(q.from && q.from > today ? q.from : today);
    const from = q.from ?? monthStartBefore(to, 11);
    const months = monthsBetween(from, to);
    if (months.length > SUMMARY_MAX_MONTHS) throw new UnprocessableEntityException(`the period can span at most ${SUMMARY_MAX_MONTHS} months`);
    const k = KINDS[kind];
    return this.db.withUser(user.id, async (c) => {
      const params: unknown[] = [from, to];
      const loc = q.locationId ? (params.push(q.locationId), `AND o.location_id = $3::uuid`) : "";
      const bills = `SELECT b.amount, b.billing_start, u.utility_type, o.id AS owner_id
        FROM eureka.utility_bill b JOIN eureka.utility u ON u.id = b.utility_id JOIN ${k.table} o ON o.id = u.${k.fk}
        WHERE b.voided_at IS NULL AND b.billing_start BETWEEN $1::date AND $2::date ${loc}`;
      const money = (e: string) => `coalesce(${e}, 0)::numeric(16,2)::text`;
      const total = (await c.query<{ count: number; amount: string; avg: string }>(
        `SELECT count(*)::int AS count, ${money("sum(x.amount)")} AS amount,
                round(coalesce(sum(x.amount), 0) / ${months.length}, 2)::numeric(16,2)::text AS avg
           FROM (${bills}) x`, params)).rows[0]!;
      const byMonth = (await c.query<{ month: string; amount: string; count: number }>(
        `SELECT to_char(x.billing_start, 'YYYY-MM') AS month, ${money("sum(x.amount)")} AS amount, count(*)::int AS count
           FROM (${bills}) x GROUP BY 1`, params)).rows;
      const byType = (await c.query<{ utilityType: string; amount: string; count: number }>(
        `SELECT x.utility_type AS "utilityType", ${money("sum(x.amount)")} AS amount, count(*)::int AS count
           FROM (${bills}) x GROUP BY 1 ORDER BY sum(x.amount) DESC, 1`, params)).rows;
      const byOwner = (await c.query<{ id: string; name: string; amount: string; count: number }>(
        `SELECT o.id, o.name, ${money("sum(x.amount)")} AS amount, count(x.owner_id)::int AS count
           FROM ${k.table} o LEFT JOIN (${bills}) x ON x.owner_id = o.id
          WHERE true ${loc}
          GROUP BY o.id, o.name ORDER BY coalesce(sum(x.amount), 0) DESC, lower(o.name), o.id`, params)).rows;
      const m = new Map(byMonth.map((r) => [r.month, r]));
      return {
        from, to,
        totalBills: total.count,
        totalAmount: total.amount,
        averagePerMonth: total.avg,
        byMonth: months.map((month) => ({ month, amount: m.get(month)?.amount ?? "0.00", count: m.get(month)?.count ?? 0 })),
        byType,
        byOwner,
      };
    });
  }

  /** CSV of an owner's non-voided bills (bill:read; CSV-injection safe; no account numbers). Audited with the row count. */
  async exportCsv(user: AuthedUser, kind: OwnerKind, ownerId: string, q: BillExportQuery) {
    if (!this.exportLimiter.take(`bills:${user.id}`)) {
      throw new HttpException("Too many exports; try again in a few minutes", HttpStatus.TOO_MANY_REQUESTS);
    }
    return this.db.withUser(user.id, async (c) => {
      await this.owner(c, user, kind, ownerId);
      const params: unknown[] = [];
      const where = this.filters(kind, ownerId, q, params);
      const statusFilter = q.status ? (params.push(q.status), `WHERE x.status = $${params.length}`) : "";
      params.push(EXPORT_ROW_CAP + 1);
      const rows = (await c.query<BillRow>(
        `SELECT * FROM (${SELECT} WHERE ${where.join(" AND ")}) x ${statusFilter}
          ORDER BY x.billing_start DESC, x.id DESC LIMIT $${params.length}`, params)).rows;
      const truncated = rows.length > EXPORT_ROW_CAP;
      const page = rows.slice(0, EXPORT_ROW_CAP);
      const csv = toCsv(
        ["Utility type", "Service provider", "Payment method", "Amount", "Billing start", "Billing end", "Due date", "Paid on", "Status"],
        page.map((r) => [r.utility_type, r.service_provider, r.payment_method, r.amount, r.billing_start, r.billing_end, r.due_date, r.paid_on, r.status]));
      await this.audit.record(c, {
        actorId: user.id, action: "bill.exported", entityType: kind, entityId: ownerId,
        changes: { rows: page.length, truncated, from: q.from ?? null, to: q.to ?? null, status: q.status ?? null, searched: q.q !== undefined },
      });
      return { csv, rows: page.length, truncated };
    });
  }
}

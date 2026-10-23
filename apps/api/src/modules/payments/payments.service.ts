import { createHash } from "node:crypto";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import type pg from "pg";
import { ownsActivity, resolveScope, type EffectiveScope, type UserAccess } from "@eureka/shared";
import { AuditService } from "../../platform/audit.service.js";
import type { AuthedUser } from "../../platform/auth.guard.js";
import { DbService } from "../../platform/db.service.js";
import { scopePredicate } from "../candidates/candidates.service.js";
import { IdempotencyKey } from "../placements/placements.schemas.js";
import { activityPredicate } from "../submissions/submissions.service.js";
import { mapPaymentError } from "./payments.errors.js";
import type {
  BillablePlacementQuery, CreateInvoice, InvoiceListQuery, InvoiceSummaryQuery, RecordPayment, UpdateInvoice,
} from "./payments.schemas.js";
import { likeContains } from "../../platform/sql.js";

/**
 * Payments / incentive dashboard (gap L1, migration 0100, docs/payments-api.md).
 * Reads run under the caller's RLS (invoice:read over the placement, like
 * placements) and the same predicate in SQL; placement data is joined, never
 * copied. Money (invoice amount, incentive part, amounts received, the
 * placement rate) is shown only where rate:read covers the placement's actor
 * snapshot (field policy B4.6, PL-6). Writes are read-before-write (404 not
 * visible, 403 without invoice:update over the placement), then the definer
 * function checks everything again. Audit rows carry ids, field names and
 * flags only: never amounts, rates or invoice numbers (rule 5).
 */

export const INVOICES_ENDPOINT = "POST /api/v1/invoices";
export const PAYMENTS_ENDPOINT = "POST /api/v1/invoices/payments";

interface InvoiceRow {
  id: string;
  placement_id: string;
  invoice_no: string | null;
  timesheet_submitted_on: string | null;
  period_start: string | null;
  period_end: string | null;
  invoice_date: string;
  terms_days: number;
  expected_date: string;
  hours: string | null;
  amount: string | null;
  incentive_amount: string | null;
  voided_at: Date | null;
  row_version: number;
  created_at: Date;
  paid_amount: string;
  payment_count: number;
  first_received_on: string | null;
  last_received_on: string | null;
  status: string;
  delay_days: number | null;
  recruiter_id: string;
  team_id: string | null;
  location_id: string | null;
  candidate_id: string;
  rate: string | null;
  placement_status: string;
  placement_type: string;
  is_first_placement: boolean;
  joined_on: string | null;
  candidate_name: string | null;
  technology: string | null;
  client_id: string;
  client_name: string;
  vendor_id: string | null;
  vendor_name: string | null;
  implementation_partner_id: string | null;
  implementation_partner_name: string | null;
  recruiter_name: string | null;
  team_name: string | null;
  lead_id: string | null;
  lead_name: string | null;
  manager_id: string | null;
  manager_name: string | null;
  ad_id: string | null;
  ad_name: string | null;
}

/**
 * The placement side of a dashboard row, joined (not copied): candidate,
 * technology, client, partner, vendor, rate, joining date, and the people
 * around it from the current hierarchy: the placement's recruiter, its team's
 * lead, the lead's manager (reporting line, as the notifications) and the
 * nearest associate director above the lead (or the recruiter when there is
 * no team lead).
 */
const PLACEMENT_JOINS = `
  LEFT JOIN eureka.candidate c ON c.id = pl.candidate_id
  LEFT JOIN eureka.person p ON p.id = c.person_id
  LEFT JOIN eureka.technology tech ON tech.id = c.technology_id
  JOIN eureka.client cl ON cl.id = pl.client_id
  LEFT JOIN eureka.vendor v ON v.id = pl.vendor_id
  LEFT JOIN eureka.implementation_partner ip ON ip.id = pl.implementation_partner_id
  LEFT JOIN eureka.assignment asg ON asg.placement_id = pl.id
  LEFT JOIN eureka.app_user ru ON ru.id = pl.recruiter_id
  LEFT JOIN eureka.team tm ON tm.id = pl.team_id
  LEFT JOIN eureka.app_user lu ON lu.id = tm.lead_id
  LEFT JOIN LATERAL (
    SELECT rl.manager_id FROM eureka.reporting_line rl
    WHERE rl.user_id = tm.lead_id AND rl.valid @> now() LIMIT 1) mg ON true
  LEFT JOIN eureka.app_user mu ON mu.id = mg.manager_id
  LEFT JOIN LATERAL (
    SELECT rc.ancestor_id FROM eureka.reporting_closure rc
    WHERE rc.descendant_id = coalesce(tm.lead_id, pl.recruiter_id) AND rc.depth > 0
      AND EXISTS (SELECT 1 FROM eureka.user_role ur
                  WHERE ur.user_id = rc.ancestor_id AND ur.role_key = 'assoc_director' AND ur.valid @> now())
    ORDER BY rc.depth LIMIT 1) adr ON true
  LEFT JOIN eureka.app_user au ON au.id = adr.ancestor_id`;

const PLACEMENT_COLUMNS = `
  pl.recruiter_id, pl.team_id, pl.location_id, pl.candidate_id, pl.rate, pl.status AS placement_status,
  pl.placement_type, pl.is_first_placement,
  coalesce(asg.start_date, (pl.joined_at AT TIME ZONE 'America/New_York')::date)::text AS joined_on,
  CASE WHEN p.id IS NOT NULL THEN p.first_name || ' ' || p.last_name END AS candidate_name,
  tech.name AS technology, cl.id AS client_id, cl.name AS client_name, v.id AS vendor_id, v.name AS vendor_name,
  ip.id AS implementation_partner_id, ip.name AS implementation_partner_name,
  ru.display_name AS recruiter_name, tm.name AS team_name, tm.lead_id, lu.display_name AS lead_name,
  mg.manager_id, mu.display_name AS manager_name, adr.ancestor_id AS ad_id, au.display_name AS ad_name`;

const SELECT = `
  SELECT iv.id, iv.placement_id, iv.invoice_no, iv.timesheet_submitted_on::text, iv.period_start::text,
         iv.period_end::text, iv.invoice_date::text, iv.terms_days, iv.expected_date::text, iv.hours, iv.amount,
         iv.incentive_amount, iv.voided_at, iv.row_version, iv.created_at, iv.paid_amount, iv.payment_count,
         iv.first_received_on::text, iv.last_received_on::text, iv.status, iv.delay_days,
         ${PLACEMENT_COLUMNS}
  FROM eureka.invoice_status iv
  JOIN eureka.placement pl ON pl.id = iv.placement_id
  ${PLACEMENT_JOINS}`;

const ref = (id: string | null, name: string | null) => (id ? { id, name } : null);
const num = (v: string | null) => (v === null ? null : Number(v));
const actor = (r: { recruiter_id: string; team_id: string | null; location_id: string | null }) => ({
  recruiterId: r.recruiter_id, teamId: r.team_id, locationId: r.location_id,
});

/** Key order does not change the hash: the same body always hashes the same. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v).sort().filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

/** Field names sent (for the audit), never their values. */
const fieldsOf = (body: object) => Object.keys(body).filter((k) => (body as Record<string, unknown>)[k] !== undefined).sort();

@Injectable()
export class PaymentsService {
  constructor(private readonly db: DbService, private readonly audit: AuditService) {}

  private readScope(access: UserAccess): EffectiveScope {
    const scope = resolveScope(access, "invoice:read");
    if (!scope) throw new ForbiddenException();
    return scope;
  }

  /** Money (amounts, incentive part, rate) only where rate:read covers the placement's actor snapshot. */
  private showMoney(access: UserAccess, r: Pick<InvoiceRow, "recruiter_id" | "team_id" | "location_id">) {
    return ownsActivity(resolveScope(access, "rate:read"), actor(r));
  }

  private canUpdate(access: UserAccess, r: Pick<InvoiceRow, "recruiter_id" | "team_id" | "location_id">) {
    return ownsActivity(resolveScope(access, "invoice:update"), actor(r));
  }

  present(access: UserAccess, r: InvoiceRow) {
    const money = this.showMoney(access, r);
    const edit = this.canUpdate(access, r);
    const live = r.voided_at === null;
    const received = r.status === "received";
    return {
      id: r.id,
      invoiceNo: r.invoice_no,
      status: r.status,
      invoiceDate: r.invoice_date,
      termsDays: r.terms_days,
      expectedDate: r.expected_date,
      timesheetSubmittedOn: r.timesheet_submitted_on,
      periodStart: r.period_start,
      periodEnd: r.period_end,
      hours: num(r.hours),
      ...(money ? {
        amount: num(r.amount), incentiveAmount: num(r.incentive_amount), paidAmount: Number(r.paid_amount), rate: num(r.rate),
      } : {}),
      paymentCount: r.payment_count,
      firstReceivedOn: r.first_received_on,
      /** Received date: the last payment of a fully received invoice; null while not fully received. */
      receivedOn: received ? r.last_received_on : null,
      delayDays: r.delay_days,
      voidedAt: r.voided_at,
      rowVersion: r.row_version,
      createdAt: r.created_at,
      placement: { id: r.placement_id, status: r.placement_status, placementType: r.placement_type, joinedOn: r.joined_on, isFirstPlacement: r.is_first_placement },
      candidate: { id: r.candidate_id, name: r.candidate_name },
      technology: r.technology,
      client: { id: r.client_id, name: r.client_name },
      implementationPartner: ref(r.implementation_partner_id, r.implementation_partner_name),
      vendor: ref(r.vendor_id, r.vendor_name),
      recruiter: { id: r.recruiter_id, name: r.recruiter_name },
      team: ref(r.team_id, r.team_name),
      lead: ref(r.lead_id, r.lead_name),
      manager: ref(r.manager_id, r.manager_name),
      associateDirector: ref(r.ad_id, r.ad_name),
      /** Hints for the UI; the server and the database check every write again. */
      actions: { edit: edit && live, recordPayment: edit && live && !received, void: edit && live && r.payment_count === 0 },
    };
  }

  /** Filters shared by the list and the summary (invoice:read predicate first). */
  private where(scope: EffectiveScope, params: unknown[], q: Partial<InvoiceListQuery>): string[] {
    const p = (v: unknown) => { params.push(v); return `$${params.length}`; };
    const where = [activityPredicate(scope, params, "pl", "c")];
    if (q.placementId) where.push(`iv.placement_id = ${p(q.placementId)}::uuid`);
    if (q.recruiterId) where.push(`pl.recruiter_id = ${p(q.recruiterId)}::uuid`);
    if (q.teamId) where.push(`pl.team_id = ${p(q.teamId)}::uuid`);
    if (q.from) where.push(`iv.invoice_date >= ${p(q.from)}::date`);
    if (q.to) where.push(`iv.invoice_date <= ${p(q.to)}::date`);
    if (q.search) {
      where.push(`(p.first_name || ' ' || p.last_name) ILIKE ${p(likeContains(q.search))} ESCAPE '\\'`);
    }
    return where;
  }

  async list(user: AuthedUser, q: InvoiceListQuery) {
    const scope = this.readScope(user.access);
    const params: unknown[] = [];
    const p = (v: unknown) => { params.push(v); return `$${params.length}`; };
    const where = this.where(scope, params, q);
    where.push(q.status ? `iv.status = ${p(q.status)}` : `iv.status <> 'void'`);
    if (q.cursor) {
      const i = q.cursor.indexOf(".");
      where.push(`(iv.invoice_date, iv.id) < (${p(q.cursor.slice(0, i))}::date, ${p(q.cursor.slice(i + 1))}::uuid)`);
    }
    const sql = `${SELECT} WHERE ${where.join(" AND ")} ORDER BY iv.invoice_date DESC, iv.id DESC LIMIT ${p(q.limit + 1)}`;
    const rows = await this.db.withUser(user.id, async (c) => (await c.query<InvoiceRow>(sql, params)).rows);
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    return {
      items: page.map((r) => this.present(user.access, r)),
      nextCursor: rows.length > q.limit && last ? `${last.invoice_date}.${last.id}` : null,
    };
  }

  /**
   * Dashboard tiles: live invoices per status (counts, the longest current
   * delay) and, where the caller may see money, totals over the invoices whose
   * amounts they can see (`amountsHidden` counts the others).
   */
  async summary(user: AuthedUser, q: InvoiceSummaryQuery) {
    const scope = this.readScope(user.access);
    const rateScope = resolveScope(user.access, "rate:read");
    const params: unknown[] = [];
    const where = this.where(scope, params, q);
    const money = rateScope ? scopePredicate({ ...rateScope, allTeams: false, hotlistOpen: false }, params, "pl") : "false";
    const sql = `
      SELECT iv.status, count(*)::int AS n,
             count(*) FILTER (WHERE NOT (${money}))::int AS hidden,
             coalesce(sum(iv.amount) FILTER (WHERE ${money}), 0)::text AS invoiced,
             coalesce(sum(iv.paid_amount) FILTER (WHERE ${money}), 0)::text AS paid,
             max(iv.delay_days)::int AS max_delay
      FROM eureka.invoice_status iv
      JOIN eureka.placement pl ON pl.id = iv.placement_id
      LEFT JOIN eureka.candidate c ON c.id = pl.candidate_id
      LEFT JOIN eureka.person p ON p.id = c.person_id
      WHERE ${where.join(" AND ")} AND iv.status <> 'void'
      GROUP BY iv.status`;
    const rows = await this.db.withUser(user.id, async (c) => (await c.query<{
      status: string; n: number; hidden: number; invoiced: string; paid: string; max_delay: number | null;
    }>(sql, params)).rows);
    const by = (s: string) => rows.find((r) => r.status === s);
    const counts = { pending: by("pending")?.n ?? 0, delayed: by("delayed")?.n ?? 0, received: by("received")?.n ?? 0 };
    const out: Record<string, unknown> = { counts, maxDelayDays: by("delayed")?.max_delay ?? 0 };
    if (rateScope) {
      const invoiced = rows.reduce((s, r) => s + Number(r.invoiced), 0);
      const paid = rows.reduce((s, r) => s + Number(r.paid), 0);
      const round = (v: number) => Math.round(v * 100) / 100;
      out.totals = { invoiced: round(invoiced), received: round(paid), outstanding: round(Math.max(invoiced - paid, 0)) };
      out.amountsHidden = rows.reduce((s, r) => s + r.hidden, 0);
    }
    return out;
  }

  /** Joined placements the caller can see under invoice:read, with their live invoice counts (the "new invoice" picker). */
  async billablePlacements(user: AuthedUser, q: BillablePlacementQuery) {
    const scope = this.readScope(user.access);
    const params: unknown[] = [];
    const p = (v: unknown) => { params.push(v); return `$${params.length}`; };
    const where = [activityPredicate(scope, params, "pl", "c"), "pl.joined_at IS NOT NULL"];
    if (q.search) {
      where.push(`(p.first_name || ' ' || p.last_name) ILIKE ${p(likeContains(q.search))} ESCAPE '\\'`);
    }
    if (q.uninvoiced) where.push(`NOT EXISTS (SELECT 1 FROM eureka.invoice i WHERE i.placement_id = pl.id AND i.voided_at IS NULL)`);
    const sql = `
      SELECT pl.id, ${PLACEMENT_COLUMNS},
             (SELECT count(*) FROM eureka.invoice i WHERE i.placement_id = pl.id AND i.voided_at IS NULL)::int AS invoice_count,
             (SELECT max(i.invoice_date) FROM eureka.invoice i WHERE i.placement_id = pl.id AND i.voided_at IS NULL)::text AS last_invoice_date
      FROM eureka.placement pl
      ${PLACEMENT_JOINS}
      WHERE ${where.join(" AND ")}
      ORDER BY pl.joined_at DESC, pl.id DESC LIMIT ${p(q.limit)}`;
    const rows = await this.db.withUser(user.id, async (c) => (await c.query<InvoiceRow & {
      id: string; invoice_count: number; last_invoice_date: string | null;
    }>(sql, params)).rows);
    return {
      items: rows.map((r) => ({
        id: r.id,
        status: r.placement_status,
        placementType: r.placement_type,
        joinedOn: r.joined_on,
        isFirstPlacement: r.is_first_placement,
        candidate: { id: r.candidate_id, name: r.candidate_name },
        technology: r.technology,
        client: { id: r.client_id, name: r.client_name },
        implementationPartner: ref(r.implementation_partner_id, r.implementation_partner_name),
        vendor: ref(r.vendor_id, r.vendor_name),
        recruiter: { id: r.recruiter_id, name: r.recruiter_name },
        team: ref(r.team_id, r.team_name),
        ...(this.showMoney(user.access, r) ? { rate: num(r.rate) } : {}),
        invoiceCount: r.invoice_count,
        lastInvoiceDate: r.last_invoice_date,
        actions: { createInvoice: this.canUpdate(user.access, r) },
      })),
    };
  }

  private async load(c: pg.PoolClient, user: AuthedUser, id: string): Promise<InvoiceRow> {
    const scope = resolveScope(user.access, "invoice:read");
    if (!scope) throw new NotFoundException();
    const params: unknown[] = [id];
    const row = (await c.query<InvoiceRow>(`${SELECT} WHERE iv.id = $1 AND ${activityPredicate(scope, params, "pl", "c")}`, params)).rows[0];
    if (!row) throw new NotFoundException();
    return row;
  }

  async get(user: AuthedUser, id: string) {
    this.readScope(user.access);
    return this.db.withUser(user.id, async (c) => {
      const row = await this.load(c, user, id);
      const payments = await c.query<{
        id: string; received_on: string; amount: string; voided_at: Date | null; created_at: Date; recorded_by: string | null;
      }>(
        `SELECT pm.id, pm.received_on::text, pm.amount, pm.voided_at, pm.created_at, u.display_name AS recorded_by
         FROM eureka.payment pm LEFT JOIN eureka.app_user u ON u.id = pm.created_by
         WHERE pm.invoice_id = $1 ORDER BY pm.received_on, pm.created_at, pm.id`, [id]);
      const base = this.present(user.access, row);
      const money = this.showMoney(user.access, row);
      const edit = this.canUpdate(user.access, row) && row.voided_at === null;
      return {
        ...base,
        payments: payments.rows.map((pm) => ({
          id: pm.id, receivedOn: pm.received_on, ...(money ? { amount: Number(pm.amount) } : {}),
          recordedBy: pm.recorded_by, recordedAt: pm.created_at, voidedAt: pm.voided_at,
          actions: { void: edit && pm.voided_at === null },
        })),
      };
    });
  }

  /** Idempotency-Key (design B3): a repeat with the same body returns the first response; a failed request does not consume the key. */
  private async claim(c: pg.PoolClient, user: AuthedUser, endpoint: string, rawKey: string | undefined, body: unknown) {
    const key = IdempotencyKey.safeParse(rawKey);
    if (!key.success) throw new BadRequestException("idempotency_key_required");
    const hash = createHash("sha256").update(canonical(body)).digest("hex");
    const claimed = await c.query(
      `INSERT INTO eureka.idempotency_key (key, user_id, endpoint, request_hash) VALUES ($1,$2,$3,$4)
       ON CONFLICT DO NOTHING RETURNING key`, [key.data, user.id, endpoint, hash]);
    if (claimed.rowCount === 0) {
      const prior = (await c.query<{ request_hash: string; response: unknown }>(
        `SELECT request_hash, response FROM eureka.idempotency_key WHERE user_id = $1 AND endpoint = $2 AND key = $3`,
        [user.id, endpoint, key.data])).rows[0];
      if (!prior || prior.request_hash !== hash || prior.response === null) throw new ConflictException("idempotency_key_reused");
      return { replay: prior.response, store: async () => undefined };
    }
    return {
      replay: undefined,
      store: async (response: unknown) => {
        await c.query(`UPDATE eureka.idempotency_key SET response = $4 WHERE user_id = $1 AND endpoint = $2 AND key = $3`,
          [user.id, endpoint, key.data, response]);
      },
    };
  }

  /** FR-PAY-01..03: Accounts raises an invoice on a joined placement it can read. */
  async create(user: AuthedUser, body: CreateInvoice, idempotencyKey: string | undefined) {
    // Malformed or missing keys are refused before anything else (400).
    if (!IdempotencyKey.safeParse(idempotencyKey).success) throw new BadRequestException("idempotency_key_required");
    return this.db.withUser(user.id, async (c) => {
      const k = await this.claim(c, user, INVOICES_ENDPOINT, idempotencyKey, body);
      if (k.replay !== undefined) return k.replay as { id: string };
      const scope = resolveScope(user.access, "invoice:read");
      if (!scope) throw new NotFoundException();
      const params: unknown[] = [body.placementId];
      const pl = (await c.query<{ recruiter_id: string; team_id: string | null; location_id: string | null; joined_at: Date | null }>(
        `SELECT pl.recruiter_id, pl.team_id, pl.location_id, pl.joined_at FROM eureka.placement pl
         LEFT JOIN eureka.candidate c ON c.id = pl.candidate_id
         WHERE pl.id = $1 AND ${activityPredicate(scope, params, "pl", "c")}`, params)).rows[0];
      if (!pl) throw new NotFoundException();
      if (!this.canUpdate(user.access, pl)) throw new ForbiddenException("Not permitted");
      if (pl.joined_at === null) throw new UnprocessableEntityException("placement_not_joined");
      let id: string;
      try {
        id = (await c.query<{ id: string }>(
          `SELECT authz.invoice_create($1, $2, $3::date, $4, $5::date, $6::date, $7::date, $8, $9, $10) AS id`,
          [body.placementId, body.invoiceNo ?? null, body.invoiceDate, body.termsDays, body.timesheetSubmittedOn ?? null,
            body.periodStart ?? null, body.periodEnd ?? null, body.hours ?? null, body.amount ?? null, body.incentiveAmount ?? null],
        )).rows[0]!.id;
      } catch (err) {
        mapPaymentError(err);
      }
      const result = { id, rowVersion: 1 };
      await k.store(result);
      await this.audit.record(c, {
        actorId: user.id, action: "invoice.created", entityType: "invoice", entityId: id,
        changes: { placementId: body.placementId, termsDays: body.termsDays, fields: fieldsOf(body) },
      });
      return result;
    });
  }

  /** Read-before-write for an invoice: 404 not visible, 403 without invoice:update, 422 void, 428/412 versions. */
  private async loadForWrite(c: pg.PoolClient, user: AuthedUser, id: string, version?: number | null) {
    const row = await this.load(c, user, id);
    if (!this.canUpdate(user.access, row)) throw new ForbiddenException("Not permitted");
    if (row.voided_at !== null) throw new UnprocessableEntityException("invoice_void");
    if (version !== undefined) {
      if (version === null) throw new HttpException("if_match_required", HttpStatus.PRECONDITION_REQUIRED);
      if (version !== row.row_version) throw new HttpException("stale", HttpStatus.PRECONDITION_FAILED);
    }
    return row;
  }

  async update(user: AuthedUser, id: string, version: number | null, body: UpdateInvoice) {
    return this.db.withUser(user.id, async (c) => {
      await this.loadForWrite(c, user, id, version);
      let rowVersion: number;
      try {
        rowVersion = (await c.query<{ v: number }>(`SELECT authz.invoice_update($1, $2, $3::jsonb) AS v`,
          [id, version, JSON.stringify(body)])).rows[0]!.v;
      } catch (err) {
        mapPaymentError(err);
      }
      await this.audit.record(c, {
        actorId: user.id, action: "invoice.updated", entityType: "invoice", entityId: id,
        changes: { fields: fieldsOf(body), ...(body.termsDays !== undefined ? { termsDays: body.termsDays } : {}) },
      });
      return { id, rowVersion };
    });
  }

  async void(user: AuthedUser, id: string, version: number | null) {
    return this.db.withUser(user.id, async (c) => {
      const row = await this.loadForWrite(c, user, id, version);
      if (row.payment_count > 0) throw new UnprocessableEntityException("invoice_has_payments");
      try {
        await c.query(`SELECT authz.invoice_void($1, $2)`, [id, version]);
      } catch (err) {
        mapPaymentError(err);
      }
      await this.audit.record(c, { actorId: user.id, action: "invoice.voided", entityType: "invoice", entityId: id, changes: { placementId: row.placement_id } });
      return { id, status: "void" };
    });
  }

  /** FR-PAY-04/05: a payment received; the first one for the placement notifies recruiter, lead and manager. */
  async recordPayment(user: AuthedUser, invoiceId: string, body: RecordPayment, idempotencyKey: string | undefined) {
    if (!IdempotencyKey.safeParse(idempotencyKey).success) throw new BadRequestException("idempotency_key_required");
    return this.db.withUser(user.id, async (c) => {
      const k = await this.claim(c, user, PAYMENTS_ENDPOINT, idempotencyKey, { invoiceId, ...body });
      if (k.replay !== undefined) return k.replay as { id: string; invoiceId: string; firstPayment: boolean };
      const row = await this.loadForWrite(c, user, invoiceId);
      if (row.status === "received") throw new UnprocessableEntityException("invoice_received");
      let r: { payment_id: string; first_payment: boolean };
      try {
        r = (await c.query<typeof r>(`SELECT * FROM authz.payment_record($1, $2::date, $3)`, [invoiceId, body.receivedOn, body.amount])).rows[0]!;
      } catch (err) {
        mapPaymentError(err);
      }
      const result = { id: r.payment_id, invoiceId, firstPayment: r.first_payment };
      await k.store(result);
      await this.audit.record(c, {
        actorId: user.id, action: "payment.recorded", entityType: "invoice", entityId: invoiceId,
        changes: { paymentId: r.payment_id, placementId: row.placement_id, receivedOn: body.receivedOn, firstPayment: r.first_payment },
      });
      return result;
    });
  }

  async voidPayment(user: AuthedUser, invoiceId: string, paymentId: string) {
    return this.db.withUser(user.id, async (c) => {
      const row = await this.loadForWrite(c, user, invoiceId);
      const pm = (await c.query<{ voided_at: Date | null }>(
        `SELECT voided_at FROM eureka.payment WHERE id = $1 AND invoice_id = $2`, [paymentId, invoiceId])).rows[0];
      if (!pm) throw new NotFoundException();
      if (pm.voided_at !== null) throw new UnprocessableEntityException("payment_void");
      try {
        await c.query(`SELECT authz.payment_void($1)`, [paymentId]);
      } catch (err) {
        mapPaymentError(err);
      }
      await this.audit.record(c, {
        actorId: user.id, action: "payment.voided", entityType: "invoice", entityId: invoiceId,
        changes: { paymentId, placementId: row.placement_id },
      });
      return { id: paymentId, invoiceId, voided: true };
    });
  }
}

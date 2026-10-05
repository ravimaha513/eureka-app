import { ForbiddenException, Injectable, NotFoundException, HttpException, HttpStatus } from "@nestjs/common";
import type pg from "pg";
import { can, type UserAccess } from "@eureka/shared";
import { AuditService } from "../../platform/audit.service.js";
import type { AuthedUser } from "../../platform/auth.guard.js";
import { DbService } from "../../platform/db.service.js";
import { RateLimiter } from "../../platform/rate-limit.js";
import { toCsv } from "../hotlist/csv.js";
import {
  EXPORTS_PER_WINDOW, EXPORT_ROW_CAP, EXPORT_WINDOW_MS, KINDS, covers, decodeCursor, encodeCursor, mapDbError, needle, requireVersion,
  type OwnerKind,
} from "./facilities.common.js";
import type {
  CompanyCreate, CompanyUpdate, FacilityCreate, FacilityUpdate, OwnerExportQuery, OwnerListQuery,
} from "./facilities.schemas.js";

interface OwnerRow {
  id: string;
  name: string;
  location_id: string;
  location_name: string;
  street: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  country: string;
  status: "active" | "inactive";
  notes: string | null;
  row_version: number;
  created_at: Date;
  updated_at: Date;
  incharges: { id: string; name: string }[];
  // company
  employee_count?: number;
  // facility
  owner_name?: string | null;
  owner_email?: string | null;
  owner_phone?: string | null;
  rent?: string | null;
  fee_frequency?: "weekly" | "monthly" | "yearly" | null;
  capacity?: number | null;
  beds?: number | null;
  baths?: number | null;
  start_date?: string | null;
  end_date?: string | null;
}

const EXTRA: Record<OwnerKind, string> = {
  company: `(SELECT count(*)::int FROM eureka.company_employee e WHERE e.company_id = o.id AND e.end_date IS NULL) AS employee_count`,
  facility: `o.owner_name, o.owner_email, o.owner_phone, o.rent::text AS rent, o.fee_frequency, o.capacity, o.beds,
             o.baths::float8 AS baths, o.start_date::text AS start_date, o.end_date::text AS end_date`,
};

const select = (kind: OwnerKind) => {
  const k = KINDS[kind];
  return `SELECT o.id, o.name, o.location_id, l.name AS location_name, o.street, o.city, o.state, o.zip, o.country, o.status,
           o.notes, o.row_version, o.created_at, o.updated_at,
           (SELECT coalesce(json_agg(json_build_object('id', u.id, 'name', u.display_name) ORDER BY u.display_name, u.id), '[]'::json)
              FROM ${k.incharges} i JOIN eureka.app_user u ON u.id = i.user_id WHERE i.${k.fk} = o.id) AS incharges,
           ${EXTRA[kind]}
    FROM ${k.table} o JOIN eureka.location l ON l.id = o.location_id`;
};

function item(kind: OwnerKind, r: OwnerRow) {
  const base = {
    id: r.id, name: r.name, location: { id: r.location_id, name: r.location_name },
    street: r.street, city: r.city, state: r.state, zip: r.zip, country: r.country,
  };
  if (kind === "company") {
    return { ...base, status: r.status, incharges: r.incharges, employeeCount: r.employee_count ?? 0, rowVersion: r.row_version };
  }
  return {
    ...base, rent: r.rent ?? null, feeFrequency: r.fee_frequency ?? null, capacity: r.capacity ?? null, beds: r.beds ?? null,
    baths: r.baths ?? null, startDate: r.start_date ?? null, endDate: r.end_date ?? null, status: r.status, incharges: r.incharges,
    rowVersion: r.row_version,
  };
}

function detail(kind: OwnerKind, r: OwnerRow, access: UserAccess) {
  return {
    ...item(kind, r),
    ...(kind === "facility" ? { ownerName: r.owner_name ?? null, ownerEmail: r.owner_email ?? null, ownerPhone: r.owner_phone ?? null } : {}),
    notes: r.notes,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
    /** Hints for the UI; the server and the database check every write again. */
    actions: { manage: covers(access, KINDS[kind].manage, r.location_id) },
  };
}

/** Editable fields per kind: API name -> row column (row values are compared to find what changed). */
const COMPANY_FIELDS = ["locationId", "name", "street", "city", "state", "zip", "country", "status", "notes"] as const;
const FACILITY_FIELDS = [...COMPANY_FIELDS, "ownerName", "ownerEmail", "ownerPhone", "rent", "feeFrequency", "capacity", "beds",
  "baths", "startDate", "endDate"] as const;
type FacilityField = (typeof FACILITY_FIELDS)[number];
const COLUMN: Record<FacilityField, keyof OwnerRow> = {
  locationId: "location_id", name: "name", street: "street", city: "city", state: "state", zip: "zip", country: "country",
  status: "status", notes: "notes", ownerName: "owner_name", ownerEmail: "owner_email", ownerPhone: "owner_phone", rent: "rent",
  feeFrequency: "fee_frequency", capacity: "capacity", beds: "beds", baths: "baths", startDate: "start_date", endDate: "end_date",
};

/**
 * Companies (own legal entities / offices) and facilities (guest houses):
 * docs/facilities-api.md, migration 0054. Reads run under the caller's RLS
 * (<kind>:read over the row's location): a row outside it is 404. Writes are
 * read-before-write (404 not visible, 403 without <kind>:manage over the
 * location), then the definer function checks everything again.
 */
@Injectable()
export class OwnersService {
  private readonly exportLimiter = new RateLimiter(EXPORTS_PER_WINDOW, EXPORT_WINDOW_MS);

  constructor(private readonly db: DbService, private readonly audit: AuditService) {}

  /** The row as the caller sees it (RLS); 404 when not visible. */
  async load(c: pg.PoolClient, kind: OwnerKind, id: string): Promise<OwnerRow> {
    const r = (await c.query<OwnerRow>(`${select(kind)} WHERE o.id = $1`, [id])).rows[0];
    if (!r) throw new NotFoundException();
    return r;
  }

  /** load() plus <kind>:manage over the row's location (403 otherwise). */
  async loadManaged(c: pg.PoolClient, user: AuthedUser, kind: OwnerKind, id: string): Promise<OwnerRow> {
    const r = await this.load(c, kind, id);
    if (!covers(user.access, KINDS[kind].manage, r.location_id)) throw new ForbiddenException("Not permitted");
    return r;
  }

  private filters(q: OwnerExportQuery, params: unknown[]): string[] {
    const p = (v: unknown) => { params.push(v); return `$${params.length}`; };
    const where = ["true"];
    if (q.status) where.push(`o.status = ${p(q.status)}`);
    if (q.locationId) where.push(`o.location_id = ${p(q.locationId)}::uuid`);
    if (q.q) {
      const n = p(needle(q.q));
      where.push(`(strpos(lower(o.name), ${n}) > 0 OR strpos(lower(coalesce(o.city, '')), ${n}) > 0
                  OR strpos(lower(coalesce(o.state, '')), ${n}) > 0 OR strpos(lower(coalesce(o.zip, '')), ${n}) > 0)`);
    }
    return where;
  }

  async list(user: AuthedUser, kind: OwnerKind, q: OwnerListQuery) {
    const params: unknown[] = [];
    const where = this.filters(q, params);
    const p = (v: unknown) => { params.push(v); return `$${params.length}`; };
    const cur = decodeCursor(q.cursor, 2);
    if (cur) where.push(`(lower(o.name), o.id) > (${p(cur[0])}, ${p(cur[1])}::uuid)`);
    const sql = `${select(kind)} WHERE ${where.join(" AND ")} ORDER BY lower(o.name), o.id LIMIT ${p(q.limit + 1)}`;
    const rows = await this.db.withUser(user.id, async (c) => (await c.query<OwnerRow>(sql, params)).rows);
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    return {
      items: page.map((r) => item(kind, r)),
      nextCursor: rows.length > q.limit && last ? encodeCursor([last.name.toLowerCase(), last.id]) : null,
    };
  }

  async get(user: AuthedUser, kind: OwnerKind, id: string) {
    return this.db.withUser(user.id, async (c) => detail(kind, await this.load(c, kind, id), user.access));
  }

  /** The body is parsed first (the target location is in it); 403 when <kind>:manage does not cover it. */
  async create(user: AuthedUser, kind: OwnerKind, body: CompanyCreate | FacilityCreate) {
    if (!covers(user.access, KINDS[kind].manage, body.locationId)) throw new ForbiddenException("Not permitted");
    return this.db.withUser(user.id, async (c) => {
      let id: string;
      if (kind === "company") {
        const b = body as CompanyCreate;
        id = (await c.query<{ id: string }>(`SELECT authz.company_create($1, $2, $3, $4, $5, $6, $7, $8) AS id`,
          [b.locationId, b.name, b.street ?? null, b.city ?? null, b.state ?? null, b.zip ?? null, b.country ?? null, b.notes ?? null])
          .catch(mapDbError)).rows[0]!.id;
      } else {
        const b = body as FacilityCreate;
        const rent = b.rent ?? null;
        id = (await c.query<{ id: string }>(
          `SELECT authz.facility_create($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18) AS id`,
          [b.locationId, b.name, b.street ?? null, b.city ?? null, b.state ?? null, b.zip ?? null, b.country ?? null,
            b.ownerName ?? null, b.ownerEmail ?? null, b.ownerPhone ?? null, rent, b.feeFrequency ?? (rent !== null ? "monthly" : null),
            b.capacity ?? null, b.beds ?? null, b.baths ?? null, b.startDate ?? null, b.endDate ?? null, b.notes ?? null])
          .catch(mapDbError)).rows[0]!.id;
      }
      // Rule 5: ids and codes only (no names, addresses, owner contact, rent or notes).
      await this.audit.record(c, { actorId: user.id, action: `${kind}.created`, entityType: kind, entityId: id, changes: { locationId: body.locationId } });
      return detail(kind, await this.load(c, kind, id), user.access);
    });
  }

  async update(user: AuthedUser, kind: OwnerKind, id: string, expectedVersion: number | null, parse: () => CompanyUpdate | FacilityUpdate) {
    return this.db.withUser(user.id, async (c) => {
      const cur = await this.loadManaged(c, user, kind, id);
      const body = parse() as Partial<Record<FacilityField, unknown>>;
      requireVersion(expectedVersion, cur.row_version);
      const fields = kind === "company" ? COMPANY_FIELDS : FACILITY_FIELDS;
      const next = Object.fromEntries(fields.map((f) => [f, body[f] !== undefined ? body[f] : cur[COLUMN[f]] ?? null])) as Record<FacilityField, unknown>;
      if (next.locationId !== cur.location_id && !covers(user.access, KINDS[kind].manage, next.locationId as string)) {
        throw new ForbiddenException("Not permitted");
      }
      let version: number;
      if (kind === "company") {
        version = (await c.query<{ v: number }>(`SELECT authz.company_update($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) AS v`,
          [id, expectedVersion, next.locationId, next.name, next.street, next.city, next.state, next.zip, next.country, next.status, next.notes])
          .catch(mapDbError)).rows[0]!.v;
      } else {
        if (next.startDate && next.endDate && (next.endDate as string) < (next.startDate as string)) {
          throw new HttpException("endDate must not be before startDate", HttpStatus.UNPROCESSABLE_ENTITY);
        }
        if (next.rent !== null && next.feeFrequency === null) next.feeFrequency = "monthly";
        version = (await c.query<{ v: number }>(
          `SELECT authz.facility_update($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21) AS v`,
          [id, expectedVersion, next.locationId, next.name, next.street, next.city, next.state, next.zip, next.country,
            next.ownerName, next.ownerEmail, next.ownerPhone, next.rent, next.feeFrequency, next.capacity, next.beds, next.baths,
            next.startDate, next.endDate, next.status, next.notes])
          .catch(mapDbError)).rows[0]!.v;
      }
      const changed = fields.filter((f) => body[f] !== undefined && String(body[f] ?? "") !== String(cur[COLUMN[f]] ?? ""));
      await this.audit.record(c, {
        actorId: user.id, action: `${kind}.updated`, entityType: kind, entityId: id,
        changes: {
          changed, rowVersion: version,
          ...(changed.includes("status") ? { status: next.status } : {}),
          ...(changed.includes("locationId") ? { locationId: next.locationId, fromLocationId: cur.location_id } : {}),
        },
      });
      return detail(kind, await this.load(c, kind, id), user.access);
    });
  }

  /** KPI cards: companies { total, active, employees }; facilities { total, active, capacity, beds, monthlyRent }. */
  async stats(user: AuthedUser, kind: OwnerKind, locationId: string | undefined) {
    return this.db.withUser(user.id, async (c) => {
      const params: unknown[] = [];
      const loc = locationId ? (params.push(locationId), `AND o.location_id = $1::uuid`) : "";
      if (kind === "company") {
        const r = (await c.query<{ total: number; active: number; employees: number }>(
          `SELECT count(*)::int AS total, count(*) FILTER (WHERE o.status = 'active')::int AS active,
                  (SELECT count(*)::int FROM eureka.company_employee e JOIN eureka.company o ON o.id = e.company_id
                    WHERE e.end_date IS NULL ${loc}) AS employees
             FROM eureka.company o WHERE true ${loc}`, params)).rows[0]!;
        return r;
      }
      // Monthly rent of active facilities: weekly x 52 / 12, yearly / 12.
      return (await c.query<{ total: number; active: number; capacity: number; beds: number; monthlyRent: string }>(
        `SELECT count(*)::int AS total, count(*) FILTER (WHERE o.status = 'active')::int AS active,
                coalesce(sum(o.capacity) FILTER (WHERE o.status = 'active'), 0)::int AS capacity,
                coalesce(sum(o.beds) FILTER (WHERE o.status = 'active'), 0)::int AS beds,
                round(coalesce(sum(CASE o.fee_frequency WHEN 'weekly' THEN o.rent * 52 / 12 WHEN 'yearly' THEN o.rent / 12 ELSE o.rent END)
                      FILTER (WHERE o.status = 'active'), 0), 2)::numeric(16,2)::text AS "monthlyRent"
           FROM eureka.facility o WHERE true ${loc}`, params)).rows[0]!;
    });
  }

  /**
   * CSV export of the list (read permission; CSV-injection safe as the Hot
   * List export). No notes, owner contact, utilities or passwords. Audited
   * with the row count and the filters (the search text is not recorded).
   */
  async exportCsv(user: AuthedUser, kind: OwnerKind, q: OwnerExportQuery) {
    if (!this.exportLimiter.take(`${kind}:${user.id}`)) {
      throw new HttpException("Too many exports; try again in a few minutes", HttpStatus.TOO_MANY_REQUESTS);
    }
    return this.db.withUser(user.id, async (c) => {
      const params: unknown[] = [];
      const where = this.filters(q, params);
      params.push(EXPORT_ROW_CAP + 1);
      const rows = (await c.query<OwnerRow>(
        `${select(kind)} WHERE ${where.join(" AND ")} ORDER BY lower(o.name), o.id LIMIT $${params.length}`, params)).rows;
      const truncated = rows.length > EXPORT_ROW_CAP;
      const page = rows.slice(0, EXPORT_ROW_CAP);
      const names = (r: OwnerRow) => r.incharges.map((i) => i.name).join("; ");
      const csv = kind === "company"
        ? toCsv(["Name", "Location", "Street", "City", "State", "ZIP", "Country", "Status", "Incharges", "Employees"],
          page.map((r) => [r.name, r.location_name, r.street, r.city, r.state, r.zip, r.country, r.status, names(r), r.employee_count ?? 0]))
        : toCsv(["Name", "Location", "Street", "City", "State", "ZIP", "Country", "Rent", "Fee frequency", "Capacity", "Beds", "Baths",
          "Start date", "End date", "Status", "Incharges"],
          page.map((r) => [r.name, r.location_name, r.street, r.city, r.state, r.zip, r.country, r.rent ?? null, r.fee_frequency ?? null,
            r.capacity ?? null, r.beds ?? null, r.baths ?? null, r.start_date ?? null, r.end_date ?? null, r.status, names(r)]));
      await this.audit.record(c, {
        actorId: user.id, action: `${kind}.exported`, entityType: kind,
        changes: { rows: page.length, truncated, status: q.status ?? null, locationId: q.locationId ?? null, searched: q.q !== undefined },
      });
      return { csv, rows: page.length, truncated };
    });
  }

  // ---------- incharges ----------

  async incharges(user: AuthedUser, kind: OwnerKind, id: string) {
    return this.db.withUser(user.id, async (c) => {
      await this.load(c, kind, id);
      const k = KINDS[kind];
      const { rows } = await c.query<{ id: string; name: string; assigned_at: Date }>(
        `SELECT u.id, u.display_name AS name, i.assigned_at FROM ${k.incharges} i JOIN eureka.app_user u ON u.id = i.user_id
          WHERE i.${k.fk} = $1 ORDER BY u.display_name, u.id`, [id]);
      return { items: rows.map((r) => ({ id: r.id, name: r.name, assignedAt: r.assigned_at.toISOString() })) };
    });
  }

  /** Active users holding a current role at the row's location and not yet in charge (<kind>:manage). */
  async inchargeOptions(user: AuthedUser, kind: OwnerKind, id: string, q: string | undefined) {
    return this.db.withUser(user.id, async (c) => {
      const o = await this.loadManaged(c, user, kind, id);
      const k = KINDS[kind];
      const { rows } = await c.query<{ id: string; name: string }>(
        `SELECT u.id, u.display_name AS name FROM eureka.app_user u
          WHERE u.status = 'active'
            AND EXISTS (SELECT 1 FROM eureka.user_role ur WHERE ur.user_id = u.id AND ur.location_id = $1 AND ur.valid @> now())
            AND NOT EXISTS (SELECT 1 FROM ${k.incharges} i WHERE i.${k.fk} = $2 AND i.user_id = u.id)
            AND ($3 = '' OR strpos(lower(u.display_name), $3) > 0)
          ORDER BY u.display_name, u.id LIMIT 50`, [o.location_id, id, needle(q)]);
      return { items: rows };
    });
  }

  async addIncharge(user: AuthedUser, kind: OwnerKind, id: string, parse: () => { userId: string }) {
    return this.db.withUser(user.id, async (c) => {
      await this.loadManaged(c, user, kind, id);
      const { userId } = parse();
      await c.query(`SELECT authz.incharge_add($1, $2, $3)`, [kind, id, userId]).catch(mapDbError);
      await this.audit.record(c, { actorId: user.id, action: `${kind}.incharge_added`, entityType: kind, entityId: id, changes: { userId } });
      const k = KINDS[kind];
      const r = (await c.query<{ id: string; name: string; assigned_at: Date }>(
        `SELECT u.id, u.display_name AS name, i.assigned_at FROM ${k.incharges} i JOIN eureka.app_user u ON u.id = i.user_id
          WHERE i.${k.fk} = $1 AND i.user_id = $2`, [id, userId])).rows[0]!;
      return { id: r.id, name: r.name, assignedAt: r.assigned_at.toISOString() };
    });
  }

  async removeIncharge(user: AuthedUser, kind: OwnerKind, id: string, userId: string) {
    await this.db.withUser(user.id, async (c) => {
      await this.loadManaged(c, user, kind, id);
      await c.query(`SELECT authz.incharge_remove($1, $2, $3)`, [kind, id, userId]).catch(mapDbError);
      await this.audit.record(c, { actorId: user.id, action: `${kind}.incharge_removed`, entityType: kind, entityId: id, changes: { userId } });
    });
  }

  // ---------- company employees ----------

  /**
   * The company's employees: names, dates and employment status through
   * authz.company_employees (eureka.employee is org-scoped, B4.4); the email
   * only for employee:read holders, read under their own RLS.
   */
  async employees(user: AuthedUser, id: string) {
    return this.db.withUser(user.id, async (c) => {
      await this.load(c, "company", id);
      const { rows } = await c.query<{ person_id: string; first_name: string; last_name: string; start_date: string; end_date: string | null; employee_status: string | null }>(
        `SELECT person_id, first_name, last_name, start_date::text, end_date::text, employee_status FROM authz.company_employees($1)`, [id])
        .catch(mapDbError);
      const emails = new Map<string, string | null>();
      if (can(user.access, "employee:read") && rows.length) {
        const e = await c.query<{ id: string; personal_email: string | null }>(
          `SELECT id, personal_email FROM eureka.person WHERE id = ANY ($1::uuid[])`, [rows.map((r) => r.person_id)]);
        for (const x of e.rows) emails.set(x.id, x.personal_email);
      }
      return {
        items: rows.map((r) => ({
          employeeId: r.person_id, name: `${r.first_name} ${r.last_name}`,
          ...(emails.size ? { email: emails.get(r.person_id) ?? null } : {}),
          startDate: r.start_date, endDate: r.end_date, status: r.employee_status,
        })),
      };
    });
  }

  async employeeOptions(user: AuthedUser, id: string, q: string | undefined) {
    return this.db.withUser(user.id, async (c) => {
      await this.loadManaged(c, user, "company", id);
      const { rows } = await c.query<{ person_id: string; first_name: string; last_name: string }>(
        `SELECT person_id, first_name, last_name FROM authz.company_employee_options($1, $2, 50)`, [id, q ?? null]).catch(mapDbError);
      return { items: rows.map((r) => ({ employeeId: r.person_id, name: `${r.first_name} ${r.last_name}` })) };
    });
  }

  async addEmployee(user: AuthedUser, id: string, parse: () => { employeeId: string; startDate: string }) {
    return this.db.withUser(user.id, async (c) => {
      await this.loadManaged(c, user, "company", id);
      const body = parse();
      await c.query(`SELECT authz.company_employee_add($1, $2, $3::date)`, [id, body.employeeId, body.startDate]).catch(mapDbError);
      await this.audit.record(c, {
        actorId: user.id, action: "company.employee_added", entityType: "company", entityId: id,
        changes: { employeeId: body.employeeId, startDate: body.startDate },
      });
      return { employeeId: body.employeeId, startDate: body.startDate, endDate: null };
    });
  }

  async endEmployee(user: AuthedUser, id: string, employeeId: string, parse: () => { endDate: string }) {
    return this.db.withUser(user.id, async (c) => {
      await this.loadManaged(c, user, "company", id);
      const body = parse();
      const start = (await c.query<{ s: string }>(`SELECT authz.company_employee_end($1, $2, $3::date)::text AS s`, [id, employeeId, body.endDate])
        .catch(mapDbError)).rows[0]!.s;
      await this.audit.record(c, {
        actorId: user.id, action: "company.employee_ended", entityType: "company", entityId: id,
        changes: { employeeId, endDate: body.endDate },
      });
      return { employeeId, startDate: start, endDate: body.endDate };
    });
  }
}

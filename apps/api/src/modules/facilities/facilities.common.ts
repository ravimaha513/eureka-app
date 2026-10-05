import {
  ConflictException, ForbiddenException, HttpException, HttpStatus, NotFoundException, UnprocessableEntityException,
} from "@nestjs/common";
import { resolveScope, type Permission, type UserAccess } from "@eureka/shared";

/** A company (own legal entity / office) or a facility (guest house). */
export type OwnerKind = "company" | "facility";

export const KINDS = {
  company: {
    table: "eureka.company", incharges: "eureka.company_incharge", fk: "company_id",
    read: "company:read", manage: "company:manage", plural: "companies",
  },
  facility: {
    table: "eureka.facility", incharges: "eureka.facility_incharge", fk: "facility_id",
    read: "facility:read", manage: "facility:manage", plural: "facilities",
  },
} as const satisfies Record<OwnerKind, { table: string; incharges: string; fk: string; read: Permission; manage: Permission; plural: string }>;

/** The permission covers this location (org scope or a location grant): mirrors authz.location_allows. */
export function covers(access: UserAccess, permission: Permission, locationId: string | null | undefined): boolean {
  const s = resolveScope(access, permission);
  return s !== null && !!locationId && (s.all || s.locationIds.has(locationId));
}

const unprocessable = (code: string) => () => new UnprocessableEntityException(code);
const conflict = (code: string) => () => new ConflictException(code);
const DB_ERRORS: Record<string, () => HttpException> = {
  not_found: () => new NotFoundException(),
  not_permitted: () => new ForbiddenException("Not permitted"),
  step_up_required: () => new ForbiddenException("step_up_required"),
  stale: () => new HttpException("stale", HttpStatus.PRECONDITION_FAILED),
  too_many_reveals: () => new HttpException("too_many_reveals", HttpStatus.TOO_MANY_REQUESTS),
  name_taken: conflict("name_taken"),
  already_incharge: conflict("already_incharge"),
  employee_assigned: conflict("employee_assigned"),
  bill_voided: conflict("bill_voided"),
  no_password: conflict("no_password"),
  too_many_pending: conflict("too_many_pending"),
  invalid_location: unprocessable("invalid_location"),
  location_in_use: unprocessable("location_in_use"),
  invalid_incharge: unprocessable("invalid_incharge"),
  invalid_employee: unprocessable("invalid_employee"),
  invalid_start_date: unprocessable("invalid_start_date"),
  invalid_end_date: unprocessable("invalid_end_date"),
  invalid_utility: unprocessable("invalid_utility"),
  invalid_password: unprocessable("invalid_password"),
  invalid_owner: unprocessable("invalid_owner"),
  invalid_upload: unprocessable("invalid_upload"),
  reason_required: unprocessable("reason_required"),
};

/** Maps the definer functions' errors (migration 0054) to problem details with the code in `detail`. */
export function mapDbError(err: unknown): never {
  const e = err as { message?: string; code?: string };
  const make = e.message !== undefined && e.code !== undefined ? DB_ERRORS[e.message] : undefined;
  if (make) throw make();
  throw err;
}

export function requireVersion(expected: number | null, current: number): void {
  if (expected === null) throw new HttpException("if_match_required", HttpStatus.PRECONDITION_REQUIRED);
  if (expected !== current) throw new HttpException("stale", HttpStatus.PRECONDITION_FAILED);
}

/** Opaque keyset cursor: base64url of a JSON array of strings. */
export function encodeCursor(parts: string[]): string {
  return Buffer.from(JSON.stringify(parts), "utf8").toString("base64url");
}
export function decodeCursor(cursor: string | undefined, n: number): string[] | null {
  if (cursor === undefined) return null;
  try {
    const v = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (Array.isArray(v) && v.length === n && v.every((x) => typeof x === "string" && x.length <= 200)) return v as string[];
  } catch { /* fall through */ }
  throw new UnprocessableEntityException("invalid_cursor");
}

/** "Today" (YYYY-MM-DD) in an IANA time zone. */
export function todayIn(tz: string, now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/** Months "YYYY-MM" from the month of `from` to the month of `to`, inclusive. */
export function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  let y = Number(from.slice(0, 4)), m = Number(from.slice(5, 7));
  const ey = Number(to.slice(0, 4)), em = Number(to.slice(5, 7));
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    if (++m > 12) { m = 1; y++; }
  }
  return out;
}

/** The first day of the month `back` months before the month of `day`. */
export function monthStartBefore(day: string, back: number): string {
  let y = Number(day.slice(0, 4)), m = Number(day.slice(5, 7)) - back;
  while (m < 1) { m += 12; y--; }
  return `${y}-${String(m).padStart(2, "0")}-01`;
}

/** The last day (YYYY-MM-DD) of the month of `day`. */
export function monthEndOf(day: string): string {
  const y = Number(day.slice(0, 4)), m = Number(day.slice(5, 7));
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

/** Substring search value for strpos(lower(...), $n) (no LIKE wildcards to escape). */
export const needle = (q: string | undefined) => (q ?? "").trim().toLowerCase();

/** Rows per CSV export (lists are small; the cap keeps a single response bounded). */
export const EXPORT_ROW_CAP = 5000;
export const EXPORTS_PER_WINDOW = 10;
export const EXPORT_WINDOW_MS = 10 * 60_000;

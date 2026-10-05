import { z } from "zod";
import { DOCUMENT_CONTENT_TYPE_LIST, DOCUMENT_MAX_BYTES, type DocumentContentType } from "@eureka/shared";

/**
 * docs/facilities-api.md. Every body is strict (design B4.7): unknown and
 * server-managed fields (ids, owner, location of a utility or bill, status at
 * creation, row versions, ciphertext, audit columns) are refused with 422.
 * Optional text fields accept "" or null as "no value". Values are never
 * echoed in errors.
 */

export const OWNER_STATUSES = ["active", "inactive"] as const;
export const FEE_FREQUENCIES = ["weekly", "monthly", "yearly"] as const;
export const UTILITY_TYPES = [
  "electricity", "water", "gas", "internet", "phone", "waste", "sewage", "hvac", "security", "cleaning", "other",
] as const;
export type UtilityType = (typeof UTILITY_TYPES)[number];
export const PAYMENT_METHODS = ["bank", "card", "ach", "check", "cash", "autopay", "other"] as const;
export const BILL_STATUSES = ["paid", "overdue", "due"] as const;
export type BillStatus = (typeof BILL_STATUSES)[number];

const CONTROL = /[\u0000-\u001f\u007f]/;
const uuid = z.string().uuid();

/** Single-line text, trimmed, 1..max characters, no control characters. */
const line = (max: number) => z.string().trim().min(1).max(max).refine((v) => !CONTROL.test(v), "Must not contain control characters");
/** Multi-line notes: newlines and tabs allowed. */
const notesText = z.string().trim().min(1).max(2000).refine((v) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v), "Must not contain control characters");
/** "" and null mean "no value"; undefined means "not given". */
const blankToNull = (v: unknown) => (typeof v === "string" && v.trim() === "" ? null : v);
const opt = <T extends z.ZodTypeAny>(t: T) => z.preprocess(blankToNull, t.nullable()).optional();

export const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD").refine((v) => {
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v && v >= "2000-01-01" && v <= "2100-12-31";
}, "Not a valid date (2000-01-01 to 2100-12-31)");

/** Money: "1234.5", "1234.50" or 1234.5; at most 10 integer digits and 2 decimals; returned as "1234.50". */
export const money = z.union([z.string().trim(), z.number().finite()]).transform((v, ctx) => {
  const s = typeof v === "number" ? String(v) : v;
  if (!/^\d{1,10}(\.\d{1,2})?$/.test(s)) {
    ctx.addIssue({ code: "custom", message: "Use an amount with at most 2 decimals" });
    return z.NEVER;
  }
  const [i, d = ""] = s.split(".");
  return `${BigInt(i!).toString()}.${d.padEnd(2, "0")}`;
});
const positiveMoney = money.refine((v) => Number(v) > 0, "Must be greater than 0");

const zip = z.string().trim().regex(/^[0-9A-Za-z][0-9A-Za-z -]{1,10}[0-9A-Za-z]$/, "Not a valid ZIP code");
const email = z.string().trim().max(254).regex(/^[^@\s]+@[^@\s]+\.[^@\s]+$/, "Not a valid email");
const phone = z.string().trim().regex(/^\+?[0-9][0-9 ().-]{5,28}[0-9]$/, "Not a valid phone number");
const count = z.number().int().min(0).max(10000);
const baths = z.number().min(0).max(99.5).refine((v) => Number.isInteger(v * 2), "Use whole or half baths");
const httpsUrl = z.string().trim().max(300).refine((v) => {
  if (!/^https:\/\/[^\s/?#]+([/?#]\S*)?$/.test(v) || CONTROL.test(v)) return false;
  try { return new URL(v).protocol === "https:"; } catch { return false; }
}, "Use an https:// address");
/** Passwords are kept exactly as typed (no trimming); 1-200 characters, no control characters. */
const password = z.string().min(1).max(200).refine((v) => !CONTROL.test(v), "Must not contain control characters");

const addressFields = {
  street: opt(line(200)),
  city: opt(line(80)),
  state: opt(line(40)),
  zip: opt(zip),
  country: opt(line(60)),
  notes: opt(notesText),
};

// ---------- companies ----------
export const CompanyCreate = z.object({ locationId: uuid, name: line(120), ...addressFields }).strict();
export type CompanyCreate = z.infer<typeof CompanyCreate>;

export const CompanyUpdate = z.object({
  locationId: uuid.optional(), name: line(120).optional(), ...addressFields, status: z.enum(OWNER_STATUSES).optional(),
}).strict();
export type CompanyUpdate = z.infer<typeof CompanyUpdate>;

// ---------- facilities ----------
const facilityFields = {
  ...addressFields,
  ownerName: opt(line(120)),
  ownerEmail: opt(email),
  ownerPhone: opt(phone),
  rent: opt(money),
  feeFrequency: opt(z.enum(FEE_FREQUENCIES)),
  capacity: opt(count),
  beds: opt(count),
  baths: opt(baths),
  startDate: opt(isoDay),
  endDate: opt(isoDay),
};
const facilityDates = (v: { startDate?: string | null; endDate?: string | null }) => !v.startDate || !v.endDate || v.endDate >= v.startDate;

export const FacilityCreate = z.object({ locationId: uuid, name: line(120), ...facilityFields }).strict()
  .refine(facilityDates, { message: "endDate must not be before startDate", path: ["endDate"] });
export type FacilityCreate = z.infer<typeof FacilityCreate>;

export const FacilityUpdate = z.object({
  locationId: uuid.optional(), name: line(120).optional(), ...facilityFields, status: z.enum(OWNER_STATUSES).optional(),
}).strict();
export type FacilityUpdate = z.infer<typeof FacilityUpdate>;

// ---------- incharges and employees ----------
export const InchargeAdd = z.object({ userId: uuid }).strict();
export const EmployeeAdd = z.object({ employeeId: uuid, startDate: isoDay }).strict();
export const EmployeeEnd = z.object({ endDate: isoDay }).strict();
export const OptionsQuery = z.object({ q: z.string().trim().max(80).optional() }).strict();

// ---------- utilities ----------
const utilityFields = {
  accountNumber: opt(line(60)),
  websiteUrl: opt(httpsUrl),
  username: opt(line(120)),
  password: password.nullable().optional(),
  notes: opt(notesText),
};
export const UtilityCreate = z.object({
  utilityType: z.enum(UTILITY_TYPES), serviceProvider: line(120), ...utilityFields,
}).strict();
export type UtilityCreate = z.infer<typeof UtilityCreate>;

/** `password: null` clears the stored password; an omitted password keeps it. */
export const UtilityUpdate = z.object({
  utilityType: z.enum(UTILITY_TYPES).optional(), serviceProvider: line(120).optional(), ...utilityFields,
  status: z.enum(OWNER_STATUSES).optional(),
}).strict();
export type UtilityUpdate = z.infer<typeof UtilityUpdate>;

// ---------- bills ----------
const billDates = (v: { billingStart?: string; billingEnd?: string }) => !v.billingStart || !v.billingEnd || v.billingEnd >= v.billingStart;

export const BillCreate = z.object({
  utilityId: uuid,
  paymentMethod: z.enum(PAYMENT_METHODS),
  amount: positiveMoney,
  billingStart: isoDay,
  billingEnd: isoDay,
  dueDate: isoDay,
  paidOn: opt(isoDay),
}).strict().refine(billDates, { message: "billingEnd must not be before billingStart", path: ["billingEnd"] });
export type BillCreate = z.infer<typeof BillCreate>;

export const BillUpdate = z.object({
  utilityId: uuid.optional(),
  paymentMethod: z.enum(PAYMENT_METHODS).optional(),
  amount: positiveMoney.optional(),
  billingStart: isoDay.optional(),
  billingEnd: isoDay.optional(),
  dueDate: isoDay.optional(),
  paidOn: opt(isoDay),
}).strict();
export type BillUpdate = z.infer<typeof BillUpdate>;

export const BillVoid = z.object({ reason: z.string().trim().min(1).max(500) }).strict();

/** Invoice upload start: the declared content type and exact size (no key or owner; a file name is ignored). */
export const InvoiceUpload = z.object({
  /** Accepted for the browser's convenience and ignored: never stored or used (rule 5; the download name is the server's). */
  fileName: z.string().max(255).optional(),
  contentType: z.enum(DOCUMENT_CONTENT_TYPE_LIST as [DocumentContentType, ...DocumentContentType[]]),
  size: z.number().int().min(1).max(DOCUMENT_MAX_BYTES),
}).strict();

// ---------- queries ----------
const listFilters = {
  q: z.string().trim().min(1).max(80).optional(),
  status: z.enum(OWNER_STATUSES).optional(),
  locationId: uuid.optional(),
};
export const OwnerListQuery = z.object({
  ...listFilters,
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(400).optional(),
}).strict();
export type OwnerListQuery = z.infer<typeof OwnerListQuery>;
export const OwnerExportQuery = z.object(listFilters).strict();
export type OwnerExportQuery = z.infer<typeof OwnerExportQuery>;
export const StatsQuery = z.object({ locationId: uuid.optional() }).strict();

const periodFilters = {
  from: isoDay.optional(),
  to: isoDay.optional(),
};
const ordered = (v: { from?: string; to?: string }) => !v.from || !v.to || v.from <= v.to;
const billFilters = {
  q: z.string().trim().min(1).max(80).optional(),
  ...periodFilters,
  utilityId: uuid.optional(),
  status: z.enum(BILL_STATUSES).optional(),
};
export const BillListQuery = z.object({
  ...billFilters,
  limit: z.coerce.number().int().min(1).max(500).default(200),
  cursor: z.string().max(200).optional(),
}).strict().refine(ordered, { message: "from must be on or before to", path: ["to"] });
export type BillListQuery = z.infer<typeof BillListQuery>;
export const BillExportQuery = z.object(billFilters).strict().refine(ordered, { message: "from must be on or before to", path: ["to"] });
export type BillExportQuery = z.infer<typeof BillExportQuery>;

function validTimeZone(tz: string): boolean {
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; }
}
export const SummaryQuery = z.object({
  ...periodFilters,
  /** IANA time zone for "today" (the default period ends in the current month there); default UTC. */
  tz: z.string().max(64).refine(validTimeZone, "unknown time zone").optional(),
  locationId: uuid.optional(),
}).strict().refine(ordered, { message: "from must be on or before to", path: ["to"] });
export type SummaryQuery = z.infer<typeof SummaryQuery>;

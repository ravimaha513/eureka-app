/**
 * Typed client for the group's own companies and facilities (guest houses), their
 * incharges, employees, utilities and bills (Phase 3b contract, migration 0054).
 * Everything is scoped to the caller's locations by the API; the can* hints below are
 * presentation only.
 */
import { ApiError, api } from "../api";
import type { UploadTicket } from "../sales/resumesApi";

/** The two kinds of site; also the path segment of their endpoints. */
export type SiteKind = "companies" | "facilities";

export type SiteStatus = "active" | "inactive";
export type FeeFrequency = "weekly" | "monthly" | "yearly";
export type BillStatus = "paid" | "due" | "overdue";
/** Money as the API sends it: a decimal string with two places (numbers are accepted too). */
export type Money = string | number;

export interface Named { id: string; name: string }

interface SiteBase {
  id: string;
  name: string;
  location: Named;
  street: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  country: string | null;
  status: SiteStatus;
  incharges: Named[];
  rowVersion: number;
}

export interface Company extends SiteBase { employeeCount: number }

export interface Facility extends SiteBase {
  rent: Money | null;
  feeFrequency: FeeFrequency | null;
  capacity: number | null;
  beds: number | null;
  baths: Money | null;
  startDate: string | null;
  endDate: string | null;
}

export type Site = Company | Facility;

interface DetailExtra { notes: string | null; createdAt: string; actions: { manage: boolean } }
export type CompanyDetail = Company & DetailExtra;
/** Owner (landlord) contact is only in the facility detail, never in lists or exports. */
export type FacilityDetail = Facility & DetailExtra & { ownerName: string | null; ownerEmail: string | null; ownerPhone: string | null };
export type SiteDetail = CompanyDetail | FacilityDetail;

export interface Page<T> { items: T[]; nextCursor: string | null }

export interface CompanyInput {
  locationId: string; name: string; street?: string; city?: string; state?: string; zip?: string; country?: string; notes?: string;
  status?: SiteStatus;
}
export interface FacilityInput extends CompanyInput {
  ownerName?: string; ownerEmail?: string; ownerPhone?: string;
  rent?: string; feeFrequency?: FeeFrequency; capacity?: number; beds?: number; baths?: number;
  startDate?: string; endDate?: string;
}

export interface CompanyEmployee { employeeId: string; name: string; email?: string | null; startDate: string; endDate: string | null; status: string }

export const UTILITY_TYPES = [
  "electricity", "water", "gas", "internet", "phone", "waste", "sewage", "hvac", "security", "cleaning", "other",
] as const;
export type UtilityType = (typeof UTILITY_TYPES)[number];
export const UTILITY_LABELS: Record<UtilityType, string> = {
  electricity: "Electricity", water: "Water", gas: "Gas", internet: "Internet", phone: "Phone", waste: "Waste",
  sewage: "Sewage", hvac: "HVAC", security: "Security", cleaning: "Cleaning", other: "Other",
};
export const utilityLabel = (t: string) => UTILITY_LABELS[t as UtilityType] ?? t;

export interface Utility {
  id: string;
  utilityType: UtilityType;
  serviceProvider: string;
  accountNumber: string | null;
  websiteUrl: string | null;
  username: string | null;
  /** The password itself is never listed; only `revealPassword` returns it. */
  hasPassword: boolean;
  status: SiteStatus;
  notes: string | null;
  rowVersion: number;
}

export interface UtilityInput {
  utilityType: UtilityType; serviceProvider: string; accountNumber?: string; websiteUrl?: string; username?: string; notes?: string;
  /** Create: optional. Update: omitted keeps the stored password, null clears it. */
  password?: string | null;
  status?: SiteStatus;
}

export const PAYMENT_METHODS = ["bank", "card", "ach", "check", "cash", "autopay", "other"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
export const PAYMENT_LABELS: Record<PaymentMethod, string> = {
  bank: "Bank transfer", card: "Card", ach: "ACH", check: "Check", cash: "Cash", autopay: "Autopay", other: "Other",
};
export const paymentLabel = (m: string) => PAYMENT_LABELS[m as PaymentMethod] ?? m;

export const BILL_STATUS_LABELS: Record<BillStatus, string> = { paid: "Paid", due: "Due", overdue: "Overdue" };

export interface Bill {
  id: string;
  utility: { id: string; utilityType: UtilityType; serviceProvider: string };
  paymentMethod: PaymentMethod;
  amount: Money;
  billingStart: string;
  billingEnd: string;
  dueDate: string;
  paidOn: string | null;
  status: BillStatus;
  invoice: { documentId: string; fileName: string } | null;
  rowVersion: number;
}

export interface BillInput {
  utilityId: string; paymentMethod: PaymentMethod; amount: string; billingStart: string; billingEnd: string; dueDate: string; paidOn?: string;
}

export interface BillsSummary {
  totalBills: number;
  totalAmount: Money;
  averagePerMonth: Money;
  byMonth: { month: string; amount: Money; count: number }[];
  byType: { utilityType: UtilityType; amount: Money; count: number }[];
  byOwner: { id: string; name: string; amount: Money; count: number }[];
}

export interface CompanyStats { total: number; active: number; employees: number }
export interface FacilityStats { total: number; active: number; capacity: number; beds: number; monthlyRent: Money }

const enc = encodeURIComponent;
const json = (b: unknown) => ({ body: JSON.stringify(b) });
const ifMatch = (rowVersion: number) => ({ "if-match": `"${rowVersion}"` });
const qs = (p: Record<string, string | number | undefined | null>) => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(p)) if (v !== undefined && v !== null && v !== "") s.set(k, String(v));
  const t = s.toString();
  return t ? `?${t}` : "";
};
const one = (kind: SiteKind, id: string) => `/api/v1/${kind}/${enc(id)}`;

export interface ListFilters { q?: string; status?: string; locationId?: string; limit?: number; cursor?: string }

export const sitesApi = {
  list: <K extends SiteKind>(kind: K, f: ListFilters = {}) =>
    api<Page<K extends "companies" ? Company : Facility>>(`/api/v1/${kind}${qs({ ...f })}`),
  get: <K extends SiteKind>(kind: K, id: string) => api<K extends "companies" ? CompanyDetail : FacilityDetail>(one(kind, id)),
  create: (kind: SiteKind, body: CompanyInput | FacilityInput) => api<Site>(`/api/v1/${kind}`, { method: "POST", ...json(body) }),
  /** Any of the create fields plus `status`; null clears an optional field. */
  update: (kind: SiteKind, id: string, rowVersion: number, body: Record<string, unknown>) =>
    api<Site>(one(kind, id), { method: "PATCH", ...json(body), headers: ifMatch(rowVersion) }),
  stats: <K extends SiteKind>(kind: K) => api<K extends "companies" ? CompanyStats : FacilityStats>(`/api/v1/${kind}/stats`),
  billsSummary: (kind: SiteKind, r: { from: string; to: string; tz: string }) => api<BillsSummary>(`/api/v1/${kind}/bills-summary${qs(r)}`),

  // Incharges (app users) of one site.
  incharges: (kind: SiteKind, id: string) => api<{ items: Named[] }>(`${one(kind, id)}/incharges`),
  inchargeOptions: (kind: SiteKind, id: string, q = "") => api<{ items: Named[] }>(`${one(kind, id)}/incharge-options${qs({ q })}`),
  addIncharge: (kind: SiteKind, id: string, userId: string) => api<unknown>(`${one(kind, id)}/incharges`, { method: "POST", ...json({ userId }) }),
  removeIncharge: (kind: SiteKind, id: string, userId: string) => api<unknown>(`${one(kind, id)}/incharges/${enc(userId)}`, { method: "DELETE" }),

  // Employees of a company (one open assignment per employee across companies).
  employees: (id: string) => api<{ items: CompanyEmployee[] }>(`${one("companies", id)}/employees`),
  employeeOptions: (id: string, q = "") => api<{ items: { employeeId: string; name: string }[] }>(`${one("companies", id)}/employee-options${qs({ q })}`),
  addEmployee: (id: string, employeeId: string, startDate: string) =>
    api<unknown>(`${one("companies", id)}/employees`, { method: "POST", ...json({ employeeId, startDate }) }),
  endEmployee: (id: string, employeeId: string, endDate: string) =>
    api<unknown>(`${one("companies", id)}/employees/${enc(employeeId)}/end`, { method: "POST", ...json({ endDate }) }),

  // Utilities (owner = company or facility).
  utilities: (kind: SiteKind, id: string) => api<{ items: Utility[] }>(`${one(kind, id)}/utilities`),
  createUtility: (kind: SiteKind, id: string, body: UtilityInput) => api<Utility>(`${one(kind, id)}/utilities`, { method: "POST", ...json(body) }),
  updateUtility: (id: string, rowVersion: number, body: Record<string, unknown>) =>
    api<Utility>(`/api/v1/utilities/${enc(id)}`, { method: "PATCH", ...json(body), headers: ifMatch(rowVersion) }),
  /** Audited; needs utility.secret:read and a live step-up (403 `step_up_required` otherwise). */
  revealPassword: (id: string) => api<{ password: string }>(`/api/v1/utilities/${enc(id)}/reveal-password`, { method: "POST" }),

  // Bills.
  bills: (kind: SiteKind, id: string, f: { q?: string; from?: string; to?: string } = {}) => api<{ items: Bill[] }>(`${one(kind, id)}/bills${qs(f)}`),
  createBill: (kind: SiteKind, id: string, body: BillInput) => api<Bill>(`${one(kind, id)}/bills`, { method: "POST", ...json(body) }),
  voidBill: (id: string, reason: string) => api<unknown>(`/api/v1/bills/${enc(id)}/void`, { method: "POST", ...json({ reason }) }),
  /** Starts an invoice upload: a presigned POST, as for paperwork documents. */
  startInvoice: (id: string, file: { fileName: string; contentType: string; size: number }) =>
    api<{ documentId?: string; upload: UploadTicket }>(`/api/v1/bills/${enc(id)}/invoice`, { method: "POST", ...json(file) }),
  invoiceLink: (id: string) => api<{ url: string; expiresAt?: string }>(`/api/v1/bills/${enc(id)}/invoice`),
};

/** CSV exports (read permission; no passwords, no owner contact). Plain links: the browser downloads them with the session cookie. */
export const exportUrl = (kind: SiteKind) => `/api/v1/${kind}/export.csv`;
export const billsExportUrl = (kind: SiteKind, id: string) => `${one(kind, id)}/bills/export.csv`;

export const siteKeys = {
  all: (kind: SiteKind) => [kind] as const,
  list: (kind: SiteKind, f: ListFilters) => [kind, "list", f] as const,
  detail: (kind: SiteKind, id: string) => [kind, "detail", id] as const,
  stats: (kind: SiteKind) => [kind, "stats"] as const,
  summary: (kind: SiteKind, r: unknown) => [kind, "bills-summary", r] as const,
  incharges: (kind: SiteKind, id: string) => [kind, "detail", id, "incharges"] as const,
  employees: (id: string) => ["companies", "detail", id, "employees"] as const,
  utilities: (kind: SiteKind, id: string) => [kind, "detail", id, "utilities"] as const,
  bills: (kind: SiteKind, id: string, q: string) => [kind, "detail", id, "bills", q] as const,
};

// ---- presentation helpers -----------------------------------------------------------------------

const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const USD0 = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
export const num = (m: Money | null | undefined) => (m === null || m === undefined || m === "" ? 0 : Number(m));
export const fmtMoney = (m: Money | null | undefined) => (m === null || m === undefined || m === "" ? "—" : USD.format(Number(m)));
/** Short money for chart axes: $950, $12k, $1.2M. */
export function fmtMoneyShort(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e6) return `$${+(n / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `$${+(n / 1e3).toFixed(1)}k`;
  return USD0.format(n);
}
export const FEE_LABELS: Record<FeeFrequency, string> = { weekly: "Weekly", monthly: "Monthly", yearly: "Yearly" };
const PER: Record<FeeFrequency, string> = { weekly: "/wk", monthly: "/mo", yearly: "/yr" };
export const fmtRent = (f: Pick<Facility, "rent" | "feeFrequency">) =>
  f.rent === null || f.rent === undefined ? "—" : `${fmtMoney(f.rent)}${f.feeFrequency ? PER[f.feeFrequency] : ""}`;

export const fmtMonth = (ym: string) => new Date(`${ym}-01T00:00:00`).toLocaleDateString("en-US", { month: "short", year: "2-digit" });

export function addressLine(s: Pick<SiteBase, "street" | "city" | "state" | "zip" | "country">): string {
  const cityState = [s.city, [s.state, s.zip].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  return [s.street, cityState, s.country].filter(Boolean).join(", ");
}

/** YYYY-MM-DD in local time. */
export function localDay(d = new Date()): string {
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
}

/** The last 12 months, this month included: the period of the KPI cards and charts. */
export function last12Months(now = new Date()): { from: string; to: string; tz: string; months: string[] } {
  const months: string[] = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  }
  let tz = "UTC";
  try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { /* default */ }
  return { from: `${months[0]}-01`, to: localDay(now), tz, months };
}

const ERRORS: Record<string, string> = {
  step_up_required: "Confirm it's you to show the password.",
  name_taken: "A company or facility with this name already exists in this location.",
  duplicate_name: "A company or facility with this name already exists in this location.",
  employee_assigned: "This employee already works for another company. End that assignment first.",
  invoice_not_ready: "The invoice is still being scanned, or did not pass the scan.",
  stale: "Someone else changed this record. Close the form and open it again to see the latest version.",
};

/** Plain-language text for the API's problems (the code is in `detail`). */
export function sitesError(e: unknown, what = "record"): string {
  if (!(e instanceof ApiError)) return e instanceof Error ? e.message : "Something went wrong.";
  if (e.detail === "upload_failed") return "The file could not be sent to storage. Try again; the link is valid for 2 minutes.";
  if (e.detail && ERRORS[e.detail]) return ERRORS[e.detail]!;
  switch (e.status) {
    case 401: return "Your session ended. Sign in again.";
    case 403: return `You don't have permission to do that for this ${what}.`;
    case 404: return `This ${what} isn't available from your account.`;
    case 409: return e.detail ? `This conflicts with the current state (${e.detail}). Refresh and try again.` : "A conflicting change was made. Refresh and try again.";
    case 412: return ERRORS.stale!;
    case 422: return e.errors?.[0]?.message ?? (e.detail ? `Check the form: ${e.detail}.` : "Check the form.");
    case 429: return e.detail ?? "Too many requests. Try again in a minute.";
    default: return e.detail ?? "Something went wrong.";
  }
}

/** Client-side checks shared by the forms (the server validates again). */
export const MONEY_RE = /^\d{1,10}(\.\d{1,2})?$/;
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const toMoney = (s: string) => Number(s).toFixed(2);

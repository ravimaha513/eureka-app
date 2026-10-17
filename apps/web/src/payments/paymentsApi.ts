/** Typed client for the Payments / incentive dashboard (docs/payments-api.md). */
import { INVOICE_STATUS_LABELS, type InvoiceStatus } from "@eureka/shared";
import { ApiError, api } from "../api";

export interface Named { id: string; name: string | null }

export interface InvoiceActions { edit: boolean; recordPayment: boolean; void: boolean }

/** One dashboard row: the invoice, its derived status, and the placement data joined from the placement. */
export interface Invoice {
  id: string;
  invoiceNo: string | null;
  status: InvoiceStatus;
  invoiceDate: string;
  termsDays: number;
  expectedDate: string;
  timesheetSubmittedOn: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  hours: number | null;
  /** Money keys are omitted without rate:read over the placement. */
  amount?: number | null;
  incentiveAmount?: number | null;
  paidAmount?: number;
  rate?: number | null;
  paymentCount: number;
  firstReceivedOn: string | null;
  receivedOn: string | null;
  delayDays: number | null;
  voidedAt: string | null;
  rowVersion: number;
  createdAt: string;
  placement: { id: string; status: string; placementType: string; joinedOn: string | null; isFirstPlacement: boolean };
  candidate: Named;
  technology: string | null;
  client: Named;
  implementationPartner: Named | null;
  vendor: Named | null;
  recruiter: Named;
  team: Named | null;
  lead: Named | null;
  manager: Named | null;
  associateDirector: Named | null;
  actions: InvoiceActions;
}

export interface PaymentEntry {
  id: string;
  receivedOn: string;
  amount?: number;
  recordedBy: string | null;
  recordedAt: string;
  voidedAt: string | null;
  actions: { void: boolean };
}

export interface InvoiceDetail extends Invoice { payments: PaymentEntry[] }

export interface Summary {
  counts: { pending: number; delayed: number; received: number };
  maxDelayDays: number;
  totals?: { invoiced: number; received: number; outstanding: number };
  amountsHidden?: number;
}

export interface BillablePlacement {
  id: string;
  status: string;
  placementType: string;
  joinedOn: string | null;
  isFirstPlacement: boolean;
  candidate: Named;
  technology: string | null;
  client: Named;
  implementationPartner: Named | null;
  vendor: Named | null;
  recruiter: Named;
  team: Named | null;
  rate?: number | null;
  invoiceCount: number;
  lastInvoiceDate: string | null;
  actions: { createInvoice: boolean };
}

export interface InvoiceFilters {
  status?: string;
  recruiterId?: string;
  teamId?: string;
  from?: string;
  to?: string;
  search?: string;
  cursor?: string;
  limit?: number;
}

/** Editable invoice fields (create and patch). */
export interface InvoiceFields {
  invoiceNo?: string | null;
  invoiceDate?: string;
  termsDays?: number;
  timesheetSubmittedOn?: string | null;
  periodStart?: string | null;
  periodEnd?: string | null;
  hours?: number | null;
  amount?: number | null;
  incentiveAmount?: number | null;
}

export const invoiceStatusLabel = (s: string) => INVOICE_STATUS_LABELS[s as InvoiceStatus] ?? s;

const enc = encodeURIComponent;
const qs = (f: object) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) if (v !== undefined && v !== null && v !== "") q.set(k, String(v));
  return q.toString();
};
const json = (b: unknown) => ({ body: JSON.stringify(b) });
const newKey = () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`);

export const paymentsApi = {
  list: (f: InvoiceFilters) => api<{ items: Invoice[]; nextCursor: string | null }>(`/api/v1/invoices?${qs({ limit: 50, ...f })}`),
  summary: (f: Omit<InvoiceFilters, "status" | "cursor" | "limit">) => api<Summary>(`/api/v1/invoices/summary?${qs(f)}`),
  placements: (f: { search?: string; uninvoiced?: boolean }) =>
    api<{ items: BillablePlacement[] }>(`/api/v1/invoices/placements?${qs({ limit: 50, ...f })}`),
  get: (id: string) => api<InvoiceDetail>(`/api/v1/invoices/${enc(id)}`),
  /** One Idempotency-Key per attempt the user starts (a retry of the same dialog reuses it). */
  create: (body: InvoiceFields & { placementId: string }, key: string = newKey()) =>
    api<{ id: string; rowVersion: number }>("/api/v1/invoices", { method: "POST", ...json(body), headers: { "idempotency-key": key } }),
  update: (id: string, version: number, body: InvoiceFields) =>
    api<{ id: string; rowVersion: number }>(`/api/v1/invoices/${enc(id)}`, { method: "PATCH", ...json(body), headers: { "if-match": `"${version}"` } }),
  void: (id: string, version: number) =>
    api<{ id: string }>(`/api/v1/invoices/${enc(id)}/void`, { method: "POST", ...json({}), headers: { "if-match": `"${version}"` } }),
  recordPayment: (id: string, body: { receivedOn: string; amount: number }, key: string = newKey()) =>
    api<{ id: string; firstPayment: boolean }>(`/api/v1/invoices/${enc(id)}/payments`, { method: "POST", ...json(body), headers: { "idempotency-key": key } }),
  voidPayment: (id: string, paymentId: string) =>
    api<{ id: string }>(`/api/v1/invoices/${enc(id)}/payments/${enc(paymentId)}/void`, { method: "POST", ...json({}) }),
  newKey,
};

export const paymentKeys = {
  all: ["payments"] as const,
  detail: (id: string) => ["payments", "detail", id] as const,
};

/** Friendly text for the API's `detail` codes. */
const ERRORS: Record<string, string> = {
  placement_not_joined: "Invoices can only be raised once the placement has joined.",
  invalid_invoice: "Check the invoice values: the invoice date can't be in the future and terms are 0 to 180 days.",
  invalid_invoice_date: "A payment was received before that date. Void the payment first or keep the earlier invoice date.",
  invoice_no_exists: "Another live invoice already uses that number.",
  invoice_void: "This invoice was voided. Refresh to see the latest state.",
  invoice_has_payments: "Void the payments recorded on this invoice first.",
  amount_below_received: "The invoice amount can't be less than what has already been received.",
  invalid_payment_date: "The payment date must be on or after the invoice date and not in the future.",
  invalid_amount: "Enter an amount greater than zero.",
  overpayment: "That payment is more than the amount still due on the invoice.",
  invoice_received: "This invoice is already fully received.",
  payment_void: "That payment was already voided.",
  stale: "Someone else changed this invoice. Close the dialog and try again with the latest values.",
  if_match_required: "Refresh the invoice and try again.",
  idempotency_key_reused: "This request was already sent with different values. Close the dialog and try again.",
  not_permitted: "You don't have permission to do that for this invoice.",
};

export function paymentError(e: unknown): string {
  if (!(e instanceof ApiError)) return e instanceof Error ? e.message : "Something went wrong.";
  if (e.detail && ERRORS[e.detail]) return ERRORS[e.detail]!;
  switch (e.status) {
    case 401: return "Your session ended. Sign in again.";
    case 403: return "You don't have permission to do that.";
    case 404: return "This record doesn't exist or is outside your scope.";
    case 412: return ERRORS.stale!;
    case 422: return e.errors?.length ? "Some fields need attention." : "The server rejected this change. Check the values and try again.";
    default: return e.detail ?? e.title ?? e.message ?? "Something went wrong.";
  }
}

/** Money as US dollars (amounts are entered and stored in USD). */
export const fmtMoney = (v: number | null | undefined) =>
  v === null || v === undefined ? "—" : v.toLocaleString("en-US", { style: "currency", currency: "USD" });

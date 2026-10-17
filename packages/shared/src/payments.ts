/**
 * Payments / incentive dashboard (gap L1, migration 0100, docs/payments-api.md).
 * Shared by the API (schemas, presentation) and the web app (labels, forms).
 * The database derives the status and the delay (view eureka.invoice_status);
 * these helpers only mirror it for display and tests.
 */

/** Derived invoice status (never stored). `void` invoices are excluded from the dashboard by default. */
export const INVOICE_STATUSES = ["pending", "delayed", "received", "void"] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

export const INVOICE_STATUS_LABELS: Record<InvoiceStatus, string> = {
  pending: "Pending",
  delayed: "Delayed",
  received: "Received",
  void: "Void",
};

/** Common payment terms offered by the form ("Net N"); any whole number of days 0..180 is accepted. */
export const PAYMENT_TERMS_DAYS = [15, 30, 45, 60, 90] as const;
export const MAX_TERMS_DAYS = 180;

/** Upper bounds, the same as the table CHECKs. */
export const MAX_INVOICE_AMOUNT = 10_000_000;
export const MAX_INCENTIVE_AMOUNT = 1_000_000;
export const MAX_INVOICE_HOURS = 5_000;

const DAY_MS = 86_400_000;
const toDay = (d: string) => Date.parse(`${d}T00:00:00Z`);
const fromDay = (t: number) => new Date(t).toISOString().slice(0, 10);

/** Expected payment date: invoice date + terms (as the generated column). */
export function expectedPaymentDate(invoiceDate: string, termsDays: number): string {
  return fromDay(toDay(invoiceDate) + termsDays * DAY_MS);
}

/**
 * Delay in days, as the view computes it: received invoices compare the last
 * payment date with the expected date, open ones compare today; never negative.
 */
export function paymentDelayDays(expected: string, receivedOn: string | null, today: string): number {
  const end = receivedOn ?? today;
  return Math.max(0, Math.round((toDay(end) - toDay(expected)) / DAY_MS));
}

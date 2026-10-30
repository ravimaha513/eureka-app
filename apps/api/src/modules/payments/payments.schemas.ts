import { z } from "zod";
import { INVOICE_STATUSES, MAX_INCENTIVE_AMOUNT, MAX_INVOICE_AMOUNT, MAX_INVOICE_HOURS, MAX_TERMS_DAYS } from "@eureka/shared";

/**
 * docs/payments-api.md. Every body is strict: unknown and server-managed fields
 * (status, expected date, delay, paid amount, versions, timestamps) are refused (422).
 * The limits repeat the table CHECKs of migration 0100.
 */
const uuid = z.string().uuid();
export const day = z.string().date().refine((d) => d >= "2000-01-01" && d <= "2100-12-31", "out of range");
const money = (max: number) => z.number().positive().max(max).multipleOf(0.01);

/** Keyset cursor "<invoice date YYYY-MM-DD>.<uuid>". */
export const InvoiceCursor = z.string().regex(/^\d{4}-\d{2}-\d{2}\.[0-9a-f-]{36}$/i, "invalid cursor");

const range = <T extends { from?: string; to?: string }>(q: T) => !q.from || !q.to || q.from <= q.to;

export const InvoiceListQuery = z
  .object({
    /** Derived status; void invoices are listed only when asked for. */
    status: z.enum(INVOICE_STATUSES).optional(),
    placementId: uuid.optional(),
    recruiterId: uuid.optional(),
    teamId: uuid.optional(),
    /** Invoice date range (inclusive days). */
    from: day.optional(),
    to: day.optional(),
    /** Candidate name. */
    search: z.string().trim().min(1).max(80).optional(),
    cursor: InvoiceCursor.optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict()
  .refine(range, { message: "from must be on or before to", path: ["to"] });
export type InvoiceListQuery = z.infer<typeof InvoiceListQuery>;

/** GET /invoices/summary: the list filters without status, placement and paging. */
export const InvoiceSummaryQuery = z
  .object({
    recruiterId: uuid.optional(),
    teamId: uuid.optional(),
    from: day.optional(),
    to: day.optional(),
    search: z.string().trim().min(1).max(80).optional(),
  })
  .strict()
  .refine(range, { message: "from must be on or before to", path: ["to"] });
export type InvoiceSummaryQuery = z.infer<typeof InvoiceSummaryQuery>;

/** GET /invoices/placements: joined placements that can carry invoices. */
export const BillablePlacementQuery = z
  .object({
    search: z.string().trim().min(1).max(80).optional(),
    /** Only placements without any live invoice. */
    uninvoiced: z.enum(["true", "false"]).transform((v) => v === "true").optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();
export type BillablePlacementQuery = z.infer<typeof BillablePlacementQuery>;

const invoiceNo = z.string().trim().min(1).max(60).regex(/^[^\p{Cc}]+$/u, "no control characters");

const invoiceFields = {
  invoiceNo: invoiceNo.nullable().optional(),
  invoiceDate: day,
  termsDays: z.number().int().min(0).max(MAX_TERMS_DAYS),
  timesheetSubmittedOn: day.nullable().optional(),
  periodStart: day.nullable().optional(),
  periodEnd: day.nullable().optional(),
  hours: money(MAX_INVOICE_HOURS).nullable().optional(),
  amount: money(MAX_INVOICE_AMOUNT).nullable().optional(),
  incentiveAmount: z.number().min(0).max(MAX_INCENTIVE_AMOUNT).multipleOf(0.01).nullable().optional(),
};

const periodOk = (v: { periodStart?: string | null; periodEnd?: string | null }) =>
  !v.periodStart || !v.periodEnd || v.periodStart <= v.periodEnd;

/** POST /invoices (Idempotency-Key required). */
export const CreateInvoice = z
  .object({ placementId: uuid, ...invoiceFields })
  .strict()
  .refine(periodOk, { message: "the period must end on or after its start", path: ["periodEnd"] });
export type CreateInvoice = z.infer<typeof CreateInvoice>;

/** PATCH /invoices/:id: any subset of the editable fields (If-Match: the rowVersion). */
export const UpdateInvoice = z
  .object({ ...invoiceFields, invoiceDate: day.optional(), termsDays: invoiceFields.termsDays.optional() })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: "nothing to change" })
  .refine(periodOk, { message: "the period must end on or after its start", path: ["periodEnd"] });
export type UpdateInvoice = z.infer<typeof UpdateInvoice>;

/** POST /invoices/:id/payments (Idempotency-Key required). */
export const RecordPayment = z.object({ receivedOn: day, amount: money(MAX_INVOICE_AMOUNT) }).strict();
export type RecordPayment = z.infer<typeof RecordPayment>;

/** Void endpoints take no fields. */
export const Empty = z.object({}).strict();

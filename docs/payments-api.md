# Payments / incentive dashboard: API contract (gap L1)

Migration `0100_payments.sql`, `apps/api/src/modules/payments`, worker job `apps/api/src/worker/jobs/payment-delay.ts`,
web `apps/web/src/payments`. Design: B2 (`invoice`, `payment`, view `invoice_status`), B4.4 "Invoices, payments", B4.6
field policy, B6 first-payment and payment-delay; SRS FR-PAY-01..06, FR-NTF-07/08; customer spec "Eureka App 4"
(payments page). JSON, RFC 9457 problems with the code in `detail`, CSRF header on writes.

## Rules

| ID | Rule |
|---|---|
| PAY-1 | An invoice belongs to one placement that has **joined** (`placement.joined_at` set, so `bgc_failed` after joining still counts). Placement data (candidate, technology, client, implementation partner, vendor, rate, joining date, recruiter, team) is joined from the placement, never copied. |
| PAY-2 | Reads: `invoice:read` over the placement's actor snapshot (recruiter, team, location) or its owned candidate, exactly like placements, and only where the placement is readable. Grants: Accounts and CEO org, Manager and Associate Director hierarchy, Lead team, Recruiter own. RLS `invoice_read` (InitPlans, hashed owned-candidate SubPlan) and `payment_read` (EXISTS on the invoice). |
| PAY-3 | Money (invoice `amount`, `incentiveAmount`, `paidAmount`, payment `amount`, placement `rate`, summary `totals`) is returned only where `rate:read` covers the placement's actor snapshot (PL-6); otherwise the keys are omitted. Recruiters and Leads therefore see dates, statuses, delays and hours but no amounts; Managers, ADs, CEO and Accounts see them. |
| PAY-4 | Writes need `invoice:update` (Accounts, org) and go only through SECURITY DEFINER functions that lock the placement and re-check visibility (404) and `invoice:update` (403): `authz.invoice_create`, `authz.invoice_update`, `authz.invoice_void`, `authz.payment_record`, `authz.payment_void`. A write guard refuses every other writer (owner included), stamps server-managed columns, never deletes, refuses TRUNCATE. |
| PAY-5 | Derived, never stored: `expectedDate = invoiceDate + termsDays` (generated column); `status` = `void` (voided) / `received` (at least one live payment and the live payments cover the amount, or any payment when no amount is set) / `delayed` (expected date before today, America/New_York) / `pending`; `delayDays` = received: last payment date − expected date; otherwise today − expected date; never negative; `null` for void. |
| PAY-6 | `Idempotency-Key` is required on `POST /invoices` and `POST /invoices/:id/payments` (design B3): a repeat with the same body returns the first response; a reused key with another body is 409 `idempotency_key_reused`; a failed request does not consume the key. |
| PAY-7 | `PATCH` and `void` need `If-Match: "<rowVersion>"` (428 `if_match_required` without, 412 `stale` when it does not match). |
| PAY-8 | Every write is audited with ids, field names, dates and flags only: never amounts, rates, hours or invoice numbers (rule 5). Actions: `invoice.created`, `invoice.updated`, `invoice.voided`, `payment.recorded`, `payment.voided`. |
| PAY-9 | Notifications (ids and counts only): `payment.first_received` the first time a payment is recorded for a placement (once per placement, even if that payment is voided and recorded again); `payment.delayed` once per invoice and expected date for live invoices past their expected date and not fully received (daily job `payment-delay`, 07:15 America/New_York; a new invoice date or terms re-arms it). See `docs/notifications.md`. |

## Endpoints

All under `/api/v1/invoices`.

| Route | Permission | Result |
|---|---|---|
| `GET /?status=&placementId=&recruiterId=&teamId=&from=&to=&search=&cursor=&limit=` | `invoice:read` | `{ items: [Invoice], nextCursor }`, invoice date descending (cursor `<date>.<id>`). Without `status`, void invoices are left out; `status=void` lists them. `from`/`to` filter the invoice date (inclusive); `search` the candidate name. |
| `GET /summary?recruiterId=&teamId=&from=&to=&search=` | `invoice:read` | `{ counts: { pending, delayed, received }, maxDelayDays, totals?: { invoiced, received, outstanding }, amountsHidden? }`: live invoices only. `totals` and `amountsHidden` (rows whose amounts the caller cannot see, not in the totals) only for callers holding `rate:read`. |
| `GET /placements?search=&uninvoiced=true&limit=` | `invoice:read` | `{ items: [BillablePlacement] }`: joined placements in scope, newest join first, with `invoiceCount`, `lastInvoiceDate` (live invoices), `rate?` (PAY-3), `actions.createInvoice`. |
| `GET /:id` | `invoice:read` | `Invoice` plus `payments: [{ id, receivedOn, amount?, recordedBy, recordedAt, voidedAt, actions: { void } }]` (void payments included, flagged). 404 outside scope. |
| `POST /` + `Idempotency-Key` | `invoice:update` | body `{ placementId, invoiceDate, termsDays, invoiceNo?, timesheetSubmittedOn?, periodStart?, periodEnd?, hours?, amount?, incentiveAmount? }` → 201 `{ id, rowVersion }` |
| `PATCH /:id` + `If-Match` | `invoice:update` | any non-empty subset of the create fields except `placementId` (`null` clears an optional field) → `{ id, rowVersion }` |
| `POST /:id/void` + `If-Match` | `invoice:update` | body `{}` → `{ id, status: "void" }` |
| `POST /:id/payments` + `Idempotency-Key` | `invoice:update` | body `{ receivedOn, amount }` → 201 `{ id, invoiceId, firstPayment }` |
| `POST /:id/payments/:paymentId/void` | `invoice:update` | body `{}` → `{ id, invoiceId, voided: true }` |

`Invoice` = `{ id, invoiceNo, status, invoiceDate, termsDays, expectedDate, timesheetSubmittedOn, periodStart, periodEnd, hours,
amount?, incentiveAmount?, paidAmount?, rate?, paymentCount, firstReceivedOn, receivedOn, delayDays, voidedAt, rowVersion, createdAt,
placement: { id, status, placementType, joinedOn, isFirstPlacement }, candidate: {id,name}, technology, client: {id,name},
implementationPartner: {id,name}|null, vendor: {id,name}|null, recruiter: {id,name}, team, lead, manager, associateDirector
({id,name}|null), actions: { edit, recordPayment, void } }`.

- `receivedOn` is the "payment received date": the last live payment of a fully received invoice, `null` until then.
- `joinedOn` is the assignment start date where the caller can read the assignment, else the day the placement was marked joined (New York).
- People come from the **current** hierarchy (not a snapshot): the placement's recruiter, its team's lead, the lead's manager (reporting
  line, as the notifications use) and the nearest Associate Director above the lead (above the recruiter when the team has no lead).
- `actions` are hints; the server and the database check every write again.

### Validation (422; the same limits are table CHECKs)

`invoiceDate` 2000-01-01 .. today (New York); `termsDays` integer 0..180 (the form offers Net 15/30/45/60/90); `timesheetSubmittedOn`
not in the future; `periodEnd` ≥ `periodStart`; `hours` > 0 and ≤ 5000; `amount` > 0 and ≤ 10,000,000; `incentiveAmount` 0..1,000,000;
money and hours with at most two decimals; `invoiceNo` 1–60 characters, no control characters, unique (case-insensitive, trimmed) among
live invoices; `receivedOn` between the invoice date and today; payment `amount` > 0.

## Error codes

`placement_not_joined`, `invalid_invoice`, `invalid_invoice_date` (an invoice date after a recorded payment), `invoice_no_exists` (409),
`invoice_void`, `invoice_has_payments` (void the payments first), `amount_below_received`, `invalid_payment_date`, `invalid_amount`,
`overpayment` (more than the amount still due), `invoice_received` (already fully received), `payment_void`, `stale` (412),
`if_match_required` (428), `idempotency_key_required` (400), `idempotency_key_reused` (409), `not_permitted` (403), plus validation errors.

## Decisions (conservative defaults; confirm with Ravi)

- **Who sees amounts:** Sales read invoices by hierarchy as the spec asks, but amounts and the rate need `rate:read` (open HANDOFF
  question "can recruiters see the rate"). Leads and recruiters see statuses, dates, delays and hours only.
- **Incentive part** is an Accounts-entered amount per invoice (design AS-10: no formula), shown with the other money.
- **Payment status** has no "partly paid" value: a partly paid invoice stays `pending` / `delayed` with `paymentCount` and `paidAmount`.
  No overpayment; a fully received invoice takes no more payments; corrections are voids (invoice or payment), never deletes.
- **Invoice prerequisites:** only joined placements; invoice dates not in the future; no rule linking the timesheet date to the invoice date.
- **Delay reminder:** once per invoice and expected date (not daily); a changed invoice date or terms re-arms it. Recipients recruiter and
  team lead (FR-NTF-08); the first-payment notice goes to recruiter, team lead and the lead's manager (FR-NTF-07). Both email + inbox,
  user-mutable in Settings (not mandatory). The inbox opens the placement.
- **Time zone:** "today" for the status, the delay and date checks is the America/New_York date, like the other reminder jobs.
- **No CSV export** in this slice (not in the spec for payments); add it with `report:export` like the other exports if wanted.

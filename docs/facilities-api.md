# Companies, facilities, utilities and bills: API contract as built (Phase 3b)

Migration `0054_companies_facilities.sql`, `apps/api/src/modules/facilities`, dev seed `apps/api/src/db/dev-facilities.ts`,
tests `apps/api/test/facilities.{api,db}.int.test.ts`. JSON, RFC 9457 problems with the code in `detail`, CSRF header on
writes, `If-Match: "<rowVersion>"` on PATCH (428 `if_match_required` without, 412 `stale` when changed), strict bodies
(unknown or server-managed keys: 422), same conventions as `docs/placements-api.md`.

Product decisions (2026-10-05): a **company** is one of the group's own legal entities/offices (not `client`); a
**facility** is a guest house the group rents. Both belong to one location and are managed by that location's
**Location Ops Admin**.

## Rules

| ID | Rule |
|---|---|
| FAC-1 | Permissions (`packages/shared/src/authz/catalog.ts`): `company:read/manage`, `facility:read/manage`, `utility:read/manage`, `utility.secret:read` (restricted), `bill:read/manage`, granted to `location_ops_admin` at scope `location` only. Location Ops Admin is therefore a restricted role (second approver). |
| FAC-2 | Scope: a row's location (company/facility `location_id`; utilities and bills inherit their owner's) must be one of the caller's location grants for the permission (or org scope). RLS (`company_read`, `facility_read`, `utility_read`, `utility_bill_read`, incharge/employee/document policies) uses InitPlan scope arrays and primary-key EXISTS (rule 3). Utilities also need the owner readable; bills also need the utility readable. |
| FAC-3 | Read-before-write: outside the caller's read scope → **404** (never 403, so other locations' rows are not disclosed); without the route's permission → 403 (guard); readable but without the manage permission over the location → 403. Creating in, or moving to, a location the caller does not manage → 403. |
| FAC-4 | Writes only through SECURITY DEFINER functions that re-check permission and location (`authz.company_create/update`, `facility_create/update`, `incharge_add/remove`, `company_employee_add/end`, `utility_create/update`, `bill_create/update/void`, `bill_invoice_upload`). Guards set `created_*`, `updated_*`, `row_version`, the status at creation (`active`) and void columns; rows are never deleted or truncated (incharges are removed by the definer only). |
| FAC-5 | Names are unique per location, case-insensitive (409 `name_taken`). A location change needs manage scope in both locations and is refused while the company has incharges or open employee assignments, or the facility has incharges (422 `location_in_use`). |
| FAC-6 | Incharges: active users holding a current role at the owner's location (422 `invalid_incharge`; 409 `already_incharge`). Adding an incharge or a company employee locks the owner row (`FOR SHARE`) and re-checks scope under the lock, so a concurrent location move cannot slip in between. |
| FAC-7 | Company employees (`eureka.employee` person ids): the employee's candidate is in the company's location and not exited (422 `invalid_employee`); one open assignment per employee across all companies (409 `employee_assigned`); a new start is not before the end of an earlier assignment (422 `invalid_start_date`); `end` sets an end date ≥ start (422 `invalid_end_date`), once. `eureka.employee` stays org-scoped (B4.4): names, dates and employment status reach `company:read` holders only through `authz.company_employees`; the email only for `employee:read` holders (none in this phase). |
| FAC-8 | Utility passwords: field class `utility_password` (FE-1/FE-2 of `docs/work-authorization-api.md`, AAD = `utility`, `password`, utility id), integrity MAC under the blind index key (FE-3a). The app role has **no column privilege** on `password_enc`, `password_key_id`, `password_mac` (only the generated `has_password`). `password: null` clears, omitted keeps. |
| FAC-9 | Reveal: `utility.secret:read` over the location, a live step-up grant of the session (`requireStepUp`, the work-authorization/restricted-documents mechanism; 403 `step_up_required`), then `authz.utility_password_reveal` re-checks scope and the step-up of the session, allows 20 reveals per user per minute and 200 per day across API tasks (429 `too_many_reveals`), writes the audit row `utility.password_revealed` `{ ownerKind, ownerId, stepUpGrantId }` and only then returns the ciphertext. MAC mismatch → 500 `integrity_check_failed`, audited `utility.integrity_failed`, alert log. `Cache-Control: no-store` (all API responses). |
| FAC-10 | Key rotation: the monthly `key-rotation` job rotates `work_auth_number` and `utility_password` (`ROTATED_CLASSES`); `authz.field_rotation_batch/apply` handle both classes; the worker got no new grant. Rotation changes only the ciphertext and its key (guard), never the MAC, `row_version` or `updated_*`. KMS: `utility_password` added to `api_field_classes` and `rotated_field_classes` (`infra/modules/stack/kms.tf`). |
| FAC-11 | Bills: `amount` > 0, money as strings with 2 decimals (requests accept `"12.5"`, `"12.50"` or `12.5`); `billingEnd ≥ billingStart`; dates 2000-01-01..2100-12-31. Status is derived: `paid` (paidOn set), `overdue` (dueDate before today in the owner location's time zone, unpaid), `due`. The utility must belong to the owner in the URL (422 `invalid_utility`). |
| FAC-12 | Void ("delete" in the UI): reason 1-500 characters, stored on the bill, never audited (`reasonGiven: true`); final (409 `bill_voided` for any later change). Voided bills are excluded from lists, exports and every total. |
| FAC-13 | Invoices reuse the 0043 document pipeline: `eureka.document` has a bill owner kind (`bill_id`, `candidate_id` NULL, type `other`, internal); presigned POST into `quarantine/documents/<file id>`, `document-scan` job, download links for clean files only (60 s), each link in `document_access` and audited `bill.invoice_downloaded` (definer). The current invoice is resolved, not stored: the bill's newest **clean** upload, else its newest upload (so the list shows `pending`/`infected` until one scans clean); an abandoned or blocked later upload never hides an earlier clean invoice. At most 3 pending uploads per bill (409 `too_many_pending`). The uploaded file name is never stored; the download name is `invoice-<billingStart>-<id8>.<ext>`. |
| FAC-14 | Summaries count non-voided bills by `billing_start` in the caller's scope. Default period: the 12 whole calendar months ending with the current month in `tz` (`to` defaults to the last day of that month, so bills later this month count) (IANA, default UTC; unknown → 422); at most 60 months. `averagePerMonth = totalAmount / months in the period` (calendar months, inclusive). `byMonth` is zero-filled; `byType` lists types with bills (amount desc); `byOwner` lists every owner in scope (zeros included, amount desc). |
| FAC-15 | Exports (CSV, the Hot List `toCsv`: formula-leading cells prefixed with `'`, BOM, CRLF): read permission, at most 5,000 rows (`x-export-rows`, `x-export-truncated`), 10 per user per 10 minutes, audited (`company.exported`, `facility.exported`, `bill.exported`: row count and filters; the search text is not recorded). No notes, owner contact, account numbers, usernames or passwords. |
| FAC-16 | Rule 5: audit rows carry ids, codes, dates, statuses and changed field names only — never names, addresses, owner contact, rent or bill amounts, account numbers, usernames, passwords, notes or void reasons (the audit redaction list covers these keys too). Nothing in this module writes `outbox_event`. |

## Endpoints

Lists take `?q=&status=&locationId=&limit=(1-200, default 50)&cursor=` and return `{ items, nextCursor }` (name order; opaque cursor).

### Companies (`company:*`)
- `GET /api/v1/companies` → items `{ id, name, location: {id,name}, street, city, state, zip, country, status, incharges: [{id,name}], employeeCount, rowVersion }`
- `POST /api/v1/companies` `{ locationId, name, street?, city?, state?, zip?, country?, notes? }` → 201 company detail
- `GET /api/v1/companies/:id` → item + `notes, createdAt, updatedAt, actions: { manage }`
- `PATCH /api/v1/companies/:id` (If-Match) any POST field + `status`; `null` (or `""`) clears an optional field → detail
- `GET /api/v1/companies/stats?locationId=` → `{ total, active, employees }` (open company assignments)
- `GET /api/v1/companies/:id/employees` → `{ items: [{ employeeId, name, email?, startDate, endDate, status }] }` (status = employment status `on_assignment|bench|exited`; open first, then newest)
- `GET /api/v1/companies/:id/employee-options?q=` (`company:manage`) → `{ items: [{ employeeId, name }] }` (≤ 50)
- `POST /api/v1/companies/:id/employees` `{ employeeId, startDate }` → 201 `{ employeeId, startDate, endDate: null }`
- `POST /api/v1/companies/:id/employees/:employeeId/end` `{ endDate }` → 200 `{ employeeId, startDate, endDate }`
- `GET /api/v1/companies/:id/incharges` → `{ items: [{ id, name, assignedAt }] }`; `GET …/incharge-options?q=` (`company:manage`) → `{ items: [{ id, name }] }`;
  `POST …/incharges` `{ userId }` → 201 `{ id, name, assignedAt }`; `DELETE …/incharges/:userId` → 204

### Facilities (`facility:*`)
Same routes without employees. Items add `rent, feeFrequency, capacity, beds, baths, startDate, endDate` (rent a 2-decimal
string or null; baths a number in halves); the detail adds `ownerName, ownerEmail, ownerPhone` (detail only).
POST/PATCH fields: `locationId, name, street, city, state, zip, country, ownerName, ownerEmail, ownerPhone, rent, feeFrequency
(weekly|monthly|yearly; defaults to monthly when rent is given), capacity, beds (0-10000), baths, startDate, endDate (≥ start), notes` (+ `status` on PATCH).
`GET /api/v1/facilities/stats` → `{ total, active, capacity, beds, monthlyRent }` (capacity, beds and rent over active
facilities; weekly rent × 52 / 12, yearly / 12; 2-decimal string).

### Utilities (`utility:*`; owner = company or facility)
- `GET /api/v1/{companies|facilities}/:id/utilities` → `{ items: [{ id, utilityType, serviceProvider, accountNumber, websiteUrl, username, hasPassword, status, notes, rowVersion }], actions: { manage, revealPassword } }`
- `POST /api/v1/{companies|facilities}/:id/utilities` `{ utilityType, serviceProvider, accountNumber?, websiteUrl? (https://), username?, password? (1-200, kept as typed), notes? }` → 201 item
- `PATCH /api/v1/utilities/:id` (If-Match) same fields + `status` → item
- `POST /api/v1/utilities/:id/reveal-password` (`utility.secret:read`, no body) → `{ password }`; 409 `no_password`, 403 `step_up_required`, 429, 500 (FAC-9)

Utility types: `electricity, water, gas, internet, phone, waste, sewage, hvac, security, cleaning, other`.

### Bills (`bill:*`)
- `GET /api/v1/{companies|facilities}/:id/bills?q=&from=&to=&utilityId=&status=paid|overdue|due&limit=(≤500, default 200)&cursor=` →
  `{ items: [{ id, utility: {id, utilityType, serviceProvider}, paymentMethod, amount, billingStart, billingEnd, dueDate, paidOn, status, invoice: {documentId, fileName, status} | null, rowVersion }], nextCursor, actions: { manage } }`
  (newest billing period first; `from`/`to` filter `billingStart`; `q` matches type, provider, payment method)
- `POST /api/v1/{companies|facilities}/:id/bills` `{ utilityId, paymentMethod, amount, billingStart, billingEnd, dueDate, paidOn? }` → 201 item
- `PATCH /api/v1/bills/:id` (If-Match) same fields (`paidOn: null` clears) → item
- `POST /api/v1/bills/:id/void` `{ reason }` → 200 `{ id, voided: true, rowVersion }`
- `POST /api/v1/bills/:id/invoice` (`bill:manage`) `{ contentType, size, fileName? }` (PDF, DOCX, PNG, JPEG ≤ 15 MB; `fileName` accepted and ignored) →
  201 `{ id, documentId, fileId, classification: "internal", status: "pending", upload: { url, fields, expiresAt } }`
- `GET /api/v1/bills/:id/invoice` (`bill:read`) → `{ url, expiresAt }`; 404 `no_invoice`; 409 `not_available` until the scan is clean

Payment methods: `bank, card, ach, check, cash, autopay, other`.

### Summaries and exports
- `GET /api/v1/{companies|facilities}/bills-summary?from=&to=&tz=&locationId=` (`bill:read`) →
  `{ from, to, totalBills, totalAmount, averagePerMonth, byMonth: [{ month: "YYYY-MM", amount, count }], byType: [{ utilityType, amount, count }], byOwner: [{ id, name, amount, count }] }`
- `GET /api/v1/companies/export.csv`, `GET /api/v1/facilities/export.csv` (`?q=&status=&locationId=`),
  `GET /api/v1/{companies|facilities}/:id/bills/export.csv` (`?q=&from=&to=&utilityId=&status=`)

## Error codes

`name_taken`, `already_incharge`, `employee_assigned`, `bill_voided`, `no_password`, `too_many_pending`, `not_available` (409);
`invalid_location`, `location_in_use`, `invalid_incharge`, `invalid_employee`, `invalid_start_date`, `invalid_end_date`,
`invalid_utility`, `invalid_password`, `invalid_upload`, `reason_required`, `invalid_cursor` (422); `if_match_required` (428);
`stale` (412); `step_up_required`, `Not permitted` (403); `no_invoice` and not found (404); `too_many_reveals` (429);
`integrity_check_failed` (500).

## Deviations from the contract (2026-10-05)

- Additive response fields: `updatedAt` on details; `assignedAt` on incharges; `actions` on utility and bill lists;
  `nextCursor` on bill lists; `invoice.status`; `documentId` on the invoice upload; `from`/`to` on summaries.
- `invoice.fileName` is generated by the server (no uploaded file name is stored, as for documents).
- Error code `employee_assigned` for a second open company assignment (named by the web build).
- Summaries/stats also accept `locationId`; bill lists also accept `utilityId`, `status`, `limit`, `cursor`.

## Dev seed

`seedDevFacilities` (from `seed-dev.ts`, development only): "Eureka Info Tech" and "Endeavour Technology" (Dallas),
"Guest House 2013" (Dallas) and "Guest House 221" (Austin), incharges `locD` (and `locA`, `opsA` for Austin), a dev-only
Austin Location Ops Admin `opsA@eureka.example`, eight utilities (one with password `dev-only-password`), twelve months
of bills each (older ones paid, one overdue) and the Dallas employees of the dev pipeline assigned to Eureka Info Tech.
All fictional.

## Open questions

- Who else should see companies/facilities (e.g. Accounts for bills, HR for company employees)? Today only Location Ops Admin.
- Should bill amounts or rent appear in exports for other roles, and should invoices be restricted? Built: internal.
- Is a company's employee list meant to include history (built: yes, ended assignments stay listed with their end date)?
- Is moving a company/facility to another location needed at all (built: allowed when it has no incharges/open employees)?

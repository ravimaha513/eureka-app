# Payments — `/payments`
Status: Audited · Redesign proposed · Implemented (rebrand wave 2)
Who / permission: `invoice:read` (nav.ts:29). Accounts create and edit with `invoice:update` (:47); Sales see invoices by hierarchy, with amounts only with `rate:read`.
Source: `apps/web/src/payments/PaymentsPage.tsx` (479 lines), `payments/paymentsApi.ts`
Evidence: `payments-desktop.png`, `payments-mobile.png`, `payments-desktop-full.png`, `payments-mobile-full.png`, `payments-acct-desktop.png`, `payments-acct-mobile.png`, `payments-newinvoice-desktop.png`, `payments-newinvoice-mobile.png`

## Primary objective
Accounts raise invoices on joined placements and record payments. Everyone in the chain sees which invoices are delayed and by how much.

## What's on screen
- Header with "New invoice" (Accounts). 4 KPI tiles (Pending, Delayed, Received, Outstanding $).
- Status chips (All, Pending, Delayed, Received, Void), Candidate search, an Invoiced from/to date range, Clear filters.
- Table: 13 columns (12 without money): Candidate, Client/vendor, Rate/part, Joined, Timesheet, Invoice, Expected, Status, Received, Hours, Recruiter/TL, Manager/AD, Open.
- Drawer: badge, 20 fact rows, Actions (Record payment / Edit / Void), and a Payments-received mini table with per-payment void.
- New/Edit invoice dialog: placement search + select, then 9 fields. Payment dialog: 2 fields.

## Problems
| # | Problem (evidence) | Category | Severity |
|---|---|---|---|
| 1 | 13 columns overflow the 1110px card even with zero rows (1130/1110 measured; `payments-acct-desktop.png` shows "Manager / AD" touching the edge, and Open is off-screen). With data, wrapped two-line cells make it wider still. The Open button, the only entry to the drawer, is the last column. | Efficiency | High |
| 2 | The KPI tiles aren't interactive. "Delayed 0 · Longest delay N days" (:83-84) duplicates the "Delayed" chip below it, but clicking the tile does nothing. The tiles also don't follow the status filter (summary uses `period` only, :56), so the numbers can disagree with the table without saying so. | Efficiency | Medium |
| 3 | In the drawer, the actions ("Record payment…", the most frequent Accounts task) come after a 20-row facts list (:204-228 → :231). On a 900px viewport the button is below the fold. | Hierarchy | High |
| 4 | Money columns aren't right-aligned or tabular. Payments cells have no `num` class (:139-151), while Sites uses `td.num` (styles.css:475). Invoice amount is the third muted line of the "Invoice" cell (:145), not its own column, so Accounts can't scan amounts. | Visual | Medium |
| 5 | The New invoice "Placement" `<fieldset>` has no styles. It renders the browser-default grey border and legend (`payments-newinvoice-desktop.png`), unlike every other form. Choosing a placement takes 2 controls (search box + select) (:372-391). | Visual | Medium |
| 6 | The placement error `<small className="error fielderr">` (:392) isn't linked to the select (`aria-invalid` is set but there's no `aria-describedby`). Other fields use `<Field>`, which links them. | A11y | Medium |
| 7 | The money inputs (Invoice amount, Incentive part, Amount received) are bare `type=number` with "(USD)" in the label. There's no `$` prefix and no thousands formatting, and the mouse wheel changes the value. | Cognitive | Low |
| 8 | The field order in the invoice dialog doesn't follow the workflow (`payments-newinvoice-desktop.png`): Invoice number/date → Terms → Timesheet → Billing period → Hours → Amount. The natural order is timesheet → billing period → hours → amount → invoice no./date → terms (the expected date follows from these). | Cognitive | Low |
| 9 | The date-range filter label "to" is a lone lowercase label (:114); a screen reader announces just "to, date". | A11y | Low |
| 10 | Mobile: the 4th KPI tile wraps alone onto a second row (`payments-mobile.png`), and the status chips wrap to 2 rows. With data the 13-column table shows about 2 columns. | Responsive | Medium |
| 11 | The open invoice isn't routed (local `openId`, :44). Delay notifications ("The recruiter and team lead are alerted when a payment is late") can't deep-link to the invoice. | Efficiency | Medium |

## Recommended redesign
### Desktop
- Columns: 8 (Candidate · client | Invoice no. + date | Amount (num) | Expected (`DueDate`, red with "Nd late") | Status | Received (date + amount) | Recruiter / TL | Manager / AD). Move Rate/part, Joined, Timesheet and Hours into the drawer. The row is the link; drop Open.
- Make the KPI tiles buttons that set the status chip (`aria-pressed` matching the chip). Label them "for invoiced period" when a date range is set.
- Drawer: a sticky action bar at the top (Record payment primary, Edit, Void in an overflow menu). Facts grouped in 3 blocks: Invoice (no., dates, terms, expected, delay, amount), Placement (candidate, client, vendor, rate, joined, timesheet, period, hours), People.
- Invoice dialog: one combobox "Placement" (search-as-you-type listbox), fields in workflow order, a `$` prefix on money inputs, and a live "Expected payment Dec 5, 2026" hint (already present, keep it).
### Mobile
- Two KPI tiles per row: Outstanding $ full-width first, then the 3 counts in a row. The chips row scrolls horizontally.
- Invoice cards: candidate + status badge, "INV-123 · $4,200 · expected Dec 5 (12d late)", tap to open the drawer as a full-screen sheet.
### Reusable components
- Existing: `Drawer`, `Field`, `DialogActions`, `fmtMoney`/`formatUsd`, `.tiles`, `td.num`.
- New shared: `MoneyInput` ($ prefix, inputMode decimal, blur-format; reused by Sites BillDialog and EmploymentDialog pay rate), `Combobox` (also needed for the Employees team picker and the Sites PickDialog), `DueDate`, `ResponsiveTable`, and a `.fieldset` reset style.

## Before/after interaction comparison
| Task | Before | After |
|---|---|---|
| Record a payment | Scroll table sideways → Open → scroll drawer → Record payment (≈4) | Click row → Record payment (top) (2) |
| See delayed invoices | Click "Delayed" chip | Click the Delayed tile or chip (1, same) |
| Pick a placement for a new invoice | Type in search → open select → choose (3) | Type → choose from listbox (2) |
| Scan amounts owed | Read the 3rd muted line in each Invoice cell | Right-aligned Amount column |

## Expected benefit
The core Accounts task (record payment) drops from about 4 actions with two scrolls to 2. Amounts become scannable, and the tiles act as shortcuts.

## Implementation complexity: M
PaymentsPage.tsx (columns, drawer layout, dialog combobox), styles.css (fieldset, tiles), App.tsx (routed id). No API change. The combobox is a new shared component (M on its own).

## Scorecard
| Dimension | Score | Evidence |
|---|---|---|
| Usability | 5 | Works, but primary action buried in the drawer (#3) |
| Visual hierarchy | 5 | Amounts buried, unaligned (#4); dead tiles (#2) |
| Efficiency | 4 | Sideways scroll + buried action; not routable (#1, #3, #11) |
| Responsiveness | 4 | Orphan tile; table unusable at 390 (#10) |
| Accessibility | 6 | Unlinked placement error (#6); lone "to" label (#9) |
| Design consistency | 5 | Unstyled fieldset (#5); money alignment differs from Sites (#4) |

## Validation
Visual inspection: desktop 1440 and mobile 390 as ceo (read-only) and acct (with New invoice), plus the New invoice dialog. The dev seed has no invoices, so the populated table, drawer and Payment dialog were reviewed from source only (`PaymentsPage.tsx:131-160, 198-260`). Overflow measured: table wrap 1130/1110 with 0 rows. Redesign validation: pending (not implemented).

### Implemented (wave 2)
| Audit item | Change | Evidence (`screenshots/after/`) |
|---|---|---|
| #1 13 columns overflow (High) | Prioritised `.dtable`: Candidate, Status, Invoice, Amount, Expected, Received, Client/vendor, Recruiter/TL, Manager/AD (p2), Rate/part, Joined, Timesheet, Hours (p3); Open pinned; row opens | payments-desktop.png |
| #2 Dead KPI tiles (Medium) | Delayed/Pending/Received tiles are `aria-pressed` shortcuts to the status filter; Outstanding first, says "for these filters" when scoped | unit test |
| #3 Record payment below the fold (High) | Drawer action strip: status, expected (Nd late), amount still due, Record payment (primary), Edit, More → Void; facts grouped Invoice / Placement / People | payments-drawer-desktop.png |
| #4 Money not aligned (Medium) | Amount is its own right-aligned tabular column; all money via one formatter | payments-desktop.png |
| #5 Unstyled fieldset (Medium) | `.pay-fieldset`: titled sunk group | — |
| #6 Placement error not linked (Medium) | `aria-describedby` to the error | — |
| #7 Money inputs (Low) | $ prefix; the wheel no longer changes values | — |
| #8 Field order (Low) | Timesheet → period → hours → amounts → invoice no./date/terms | — |
| #9 Lone "to" label (Low) | "Invoiced to" | — |
| #10 Phone tiles and table (Medium) | Outstanding full width, three counts in a row; invoice cards | payments-mobile.png |
| #11 Invoice not routed (Medium) | `initialOpenId` / `onOpenChange` props (App.tsx change requested) | app_requests |

Not changed / deferred: Placement picker stays search + select (no shared listbox combobox in the kit).

Validation (wave 2): typecheck clean; unit tests for paperwork, employees, payments, sites and datahub pass (87). The shared API on :3000 and its Postgres were down during this wave (the session could not restart them), so the visual check ran against the built screens with the network layer mocked by fictional fixtures (Playwright `page.route`), at 1440×900 and 390×844, light and dark. Page width at 390 is 390 on every screen and state; no table wrap scrolls sideways at either width; every row action column (`td.c-act`) is inside the viewport at 1440. Re-check against live seeded data when the API is back.

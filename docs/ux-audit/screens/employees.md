# Employees — `/employees`
Status: Audited · Redesign proposed · Implemented (rebrand wave 2)
Who / permission: `employee:read` (nav.ts:26) — HR, Accounts, CEO, managers by scope; lifecycle actions from `employee.actions`; Export with `report:export`
Source: `apps/web/src/employees/EmployeesPage.tsx` (559 lines). `employees/MarketReport.tsx` is rendered inside Reports (`JoiningsExitsReport.tsx:7`), not on this route; it's covered in the appendix below.
Evidence: `employees-desktop.png`, `employees-desktop-full.png`, `employees-mobile.png`, `employees-mobile-full.png`, `employees-detail-drawer-desktop.png`, `employees-detail-drawer-mobile.png`

## Primary objective
HR/Accounts find an employee (by status, client, or "ending soon") and run a lifecycle action: set or extend the planned end, end the assignment, record an exit, return to market, or assign a team.

## What's on screen
- Header and sub. Status chips (All / On assignment / Bench / Exited).
- Toolbar: Name search, up to 4 selects (Location, Client, Vendor, Payroll company), "Current assignment only" (shown only when a client is chosen), "Ending within 30 days" checkbox, Clear filters, Export CSV.
- Table: 9 columns (Employee, Contact, Status, Current client, Assignment, Planned end, Location/team, Lead/recruiter, Open).
- Drawer (wide): status badge, 9 facts, Actions (up to 5 buttons), an Assignments mini table (up to 12 columns), History timeline. 6 dialogs (End, Planned end, Exit, Market, Team, Employment details).

## Problems
| # | Problem (evidence) | Category | Severity |
|---|---|---|---|
| 1 | At 1440px the table is 1203px in a 1110px card (measured). The Open column, the only way into the drawer (rows aren't clickable, :170-205), is clipped off the right edge in `employees-desktop.png`. Users have to scroll the card sideways to reach the primary action on the default desktop size. | Efficiency | Critical |
| 2 | The Assignment cell stacks "No. 1" plus a date range that wraps to 4 lines ("Nov 4, / 2026 – / Nov 4, / 2026", `employees-desktop.png`). That doubles the row height. "Planned end" is a separate column even though it belongs to the same assignment. | Visual | Medium |
| 3 | "Ending within 30 days", the main HR worklist, is a checkbox at the end of the filter row. Planned-end dates inside the window aren't highlighted in the table (:187). | Hierarchy | Medium |
| 4 | The drawer's Assignments table has up to 12 columns in a 572px drawer (1032/572 measured). Payroll company, E-Verify, Onboarded, Pay rate and Edit are off-screen (`employees-detail-drawer-desktop.png`, "Planne…" cut). These are exactly the fields Accounts opens the drawer to edit. | Responsive | High |
| 5 | The open employee isn't in the URL (`openId` is local state, :57). App.tsx:478 passes no `recordId`, unlike Paperwork. A drawer can't be linked, refreshed or opened from a notification. | Efficiency | Medium |
| 6 | Phone numbers render raw E.164 ("+14695550001", :37). The facility owner phone renders formatted ("+1 214 555 0100", `facilities-detail-overview-desktop.png`). | Design consistency | Low |
| 7 | Pay rate is formatted by hand as `` `$${x.payRate.toFixed(2)}/h` `` (:310) instead of the shared `formatUsd` (`lib/format.ts:13`) that Payments and Sites use. No thousands separator, and it diverges if the locale or currency changes. | Design consistency | Low |
| 8 | Action labels mix verbs and nouns with ellipses: "Reassign: return to marketing…", "Assign a team…", "Record exit…", "End assignment (project exit)…" (:274-278). Destructive buttons (End, Record exit) sit inline beside routine ones with the same size. | Cognitive | Low |
| 9 | Mobile: the table scrolls 1203/360, showing only Employee and Contact (`employees-mobile.png`). Filters take the first full screen. Phone links are 17px tall (122×17 measured, < 24px target). | Responsive | High |
| 10 | Export CSV is pushed to its own wrapped line under the filters on desktop (`employees-desktop.png`, `.btn.push` :157), so it reads as part of the filter set. | Visual | Low |

## Recommended redesign
### Desktop
- Make the whole row the link (`tr.clickrow` + name as `<a>` to a routed `/employees/<id>`). Drop the Open column. That frees about 90px and fixes #1.
- Merge columns into 7: Employee (name, since) | Status (badge + since) | Client · assignment No. | Dates ("Nov 1 → ongoing", with the planned end below in amber when within 30d) | Location / team | Lead / recruiter | Contact (icons only with tooltip; full value on hover/focus). The table then fits 1110px.
- Promote "Ending within 30 days" to a status-row chip with a count ("Ending soon · 3"), next to the status chips.
- Export goes into the page header (right), as on Payments/Sites.
- Drawer: replace the 12-column Assignments table with one card per assignment (a 2-column `dl`: Client/vendor, Dates, Reason, Payroll company, E-Verify, Onboarded, Pay rate) plus an Edit button on the card. Put destructive actions in a separate "Danger zone" row at the bottom of Actions.
### Mobile
- Employee cards: name + status badge, client · dates, then tap-to-call/mail icon buttons at 44px.
- Filters behind a "Filters (n)" sheet button; status chips stay visible.
### Reusable components
- Existing: `StatusChips`, `Person`, `Drawer`, `ConfirmDialog`, `useRoutedId` (lib/router), `formatUsd`.
- New shared: `fmtPhone` in `lib/format.ts` (one phone format app-wide), `DueDate` (see `paperwork.md`), `ResponsiveTable`.

## Before/after interaction comparison
| Task | Before | After |
|---|---|---|
| Open an employee at 1440px | Scroll the card sideways → Open (2) | Click the row (1) |
| Find who ends this month | Tick the checkbox at the end of the toolbar, read dates | Click "Ending soon · 3" chip; dates already amber |
| Edit an assignment's payroll company | Open → scroll the drawer table sideways → Edit → dialog (4) | Open → Edit on assignment card (2) |
| Share an employee with a colleague | Not possible | Copy URL |

## Expected benefit
Removes a sideways scroll from the most common action on desktop. The HR "ending soon" worklist becomes one click. Accounts' employment fields become visible without scrolling.

## Implementation complexity: M
EmployeesPage.tsx (columns, row link, drawer cards), App.tsx:478 (pass `recordId`, like paperwork), styles.css. No API change.

## Scorecard
| Dimension | Score | Evidence |
|---|---|---|
| Usability | 4 | Primary action clipped at 1440 (#1) |
| Visual hierarchy | 6 | 4-line date cells; buried ending-soon (#2, #3) |
| Efficiency | 4 | Sideways scroll to open; not routable (#1, #5) |
| Responsiveness | 3 | 2 of 9 columns visible on mobile; drawer table clipped (#4, #9) |
| Accessibility | 7 | Labelled filters, live counts, aria-labels on Open; small phone link targets |
| Design consistency | 6 | Hand-rolled money and phone formats (#6, #7) |

## Validation
Visual inspection: desktop 1440 and mobile 390 as ceo and hr, list and drawer. Overflow measured: list wrap 1203/1110 (desktop), 1203/360 (mobile); drawer table 1032/572. Redesign validation: pending (not implemented).

## Appendix — Market report panel (`MarketReport.tsx`, shown under Reports)
| # | Problem | Category | Severity |
|---|---|---|---|
| A1 | The count columns (Candidates, In market, Placed, per-status) have no `className="num"` (:44-46), so they're left-aligned. Sites tables right-align numbers with `td.num` (styles.css:475). | Visual | Medium |
| A2 | "Group by" wraps its select in a `<label>` inside `.field.inline` (:55-60), while the date fields use a separate `<label htmlFor>`. That's two label patterns in one toolbar. | Design consistency | Low |
| A3 | The export hint text sits inside the toolbar under the button (:79) and shifts the layout whenever export permission varies. | Visual | Low |
Fix: add `num` to the count cells and headers, use `<Field>` for all three controls, and move the hint to a `title` or the success message.

### Implemented (wave 2)
| Audit item | Change | Evidence (`screenshots/after/`) |
|---|---|---|
| #1 Open clipped at 1440 (Critical) | `.dtable` with priority columns: Employee, Status, Client · assignment, Dates, Lead/recruiter, Location/team (p2), Contact (wide screens and phone cards); Open pinned right; row and name open the drawer | employees-desktop.png (c-act in view) |
| #2 Four-line date cells (Medium) | One Dates cell: start → end/ongoing, planned end below | employees-desktop.png |
| #3 Ending soon buried (Medium) | Ending within 30 days sits inline next to the Status toggles; planned ends within 30 days are flagged "in Nd" (warn) | employees-desktop.png |
| #4 Drawer assignments 12 columns (High) | Four stacked columns (Client · vendor, Dates, Employment, Pay rate) + Edit; wraps inside the 572px drawer | employees-drawer-desktop.png |
| #5 Drawer not routed (Medium) | `initialOpenId` / `onOpenChange` props via `useRoutedId` (App.tsx change requested) | app_requests |
| #6 Raw E.164 phones (Low) | `fmtPhone` (+1 469 555 0001); tel: keeps the raw value | employees-mobile.png |
| #7 Hand-rolled pay rate (Low) | `fmtUsd` (shared back-office formatter) | unit test |
| #8 Action labels / destructive inline (Low) | Action strip: primary next step, then routine, then End assignment… and Record exit… in danger style last | employees-drawer-desktop.png |
| #9 Phone: 2 of 9 columns (High) | Record cards; filters in the bottom sheet | employees-mobile.png |
| #10 Export in the filter row (Low) | Export CSV in the page head | employees-desktop.png |
| Filters in URL | status, loc, client, current, vendor, payroll, soon, q; Client/Vendor/Payroll behind More filters as chips | unit test |

Validation (wave 2): typecheck clean; unit tests for paperwork, employees, payments, sites and datahub pass (87). The shared API on :3000 and its Postgres were down during this wave (the session could not restart them), so the visual check ran against the built screens with the network layer mocked by fictional fixtures (Playwright `page.route`), at 1440×900 and 390×844, light and dark. Page width at 390 is 390 on every screen and state; no table wrap scrolls sideways at either width; every row action column (`td.c-act`) is inside the viewport at 1440. Re-check against live seeded data when the API is back.

# Companies and Facilities — `/companies`, `/facilities`
Status: Audited · Redesign proposed
Both routes render the same component, `SitesPage` with `kind` (SitesPage.tsx:20-21), so they share this one report. Differences are noted inline.
Who / permission: `company:read` / `facility:read` (nav.ts:30-31) — location ops (locD), CEO/admin. Add/Edit with `company:manage` / `facility:manage`; Utilities tab `utility:read` (password reveal `utility.secret:read` + step-up); Bills `bill:read` / `bill:manage`.
Source: `apps/web/src/sites/SitesPage.tsx`, `SiteDrawer.tsx`, `SiteFormDialog.tsx`, `PeopleTabs.tsx`, `UtilitiesTab.tsx`, `BillsTab.tsx`, `sites/ui.tsx`, `ui/Charts.tsx`
Evidence: `companies-desktop.png`, `companies-mobile.png`, `companies-*-full.png`, `facilities-desktop.png`, `facilities-desktop-full.png`, `facilities-mobile*.png`, `facilities-detail-overview-{desktop,mobile}.png`, `facilities-detail-bills-{desktop,mobile}.png`, `facilities-detail-utilities-{desktop,mobile}.png`, `companies-detail-{overview,bills,utilities}-{desktop,mobile}.png`

## Primary objective
Location ops keep each company or rented facility up to date: incharges, employees, utilities with portal logins, and monthly bills with invoice files. They also see what each site costs.

## What's on screen
- Header and "Add company/facility". 4 KPI cards with icons (Companies: total, active, employees, bills 12mo; Facilities: total, capacity, monthly rent, bills 12mo).
- A "List" card with search and Export inside its header. Table of 7 columns (companies) or 10 (facilities). Clickable rows, a name linkbtn and an "Edit" linkbtn. Pager.
- Charts: Bills by month (area), Utility bills by type (donut), and a "Bills total by …" table with share bars.
- Drawer "Company/Facility details": icon header with name, status, address and Edit. Pill tabs: Overview, Employees (companies only), Incharges, Utilities, Bills.
- Bills tab: search, Export, Add bill, and a 9-column table with icon actions (Upload invoice, Download, Void). Utilities tab: 6 columns with reveal/copy/hide password icons and Edit.

## Problems
| # | Problem (evidence) | Category | Severity |
|---|---|---|---|
| 1 | The Bills table in the drawer has no pagination or date filter. It renders every bill (36 rows for one facility, `facilities-detail-bills-desktop.png`), and it's wider than the drawer (873/830 measured). The action icons (Upload, Download, Void) are partly off the right edge, and on mobile (873/356) only Utility, Payment and Amount show. | Efficiency | High |
| 2 | The Invoice column shows only the filename or "None" (BillsTab.tsx:130). After an upload there's no per-row scanning/ready/rejected state; the scan result appears only on a failed download as a 409 message (:85). Compare `DocumentsSection`, which polls and shows a status badge. | Cognitive | High |
| 3 | Upload progress is the text "Uploading…" written to `.livemsg` (BillsTab.tsx:65). `.livemsg` is styled as a green success banner (styles.css:190), so an in-progress upload looks like a success. There's no row-level spinner, only `aria-busy` on the icon (:133). | Visual | Medium |
| 4 | Export ignores the search. `exportUrl(kind)` (sitesApi.ts:198) has no `q`, but the button sits beside the search box (SitesPage.tsx:105-110), which implies "export these". It's an `<a download>`, so a 4xx/5xx downloads an error file with no in-app message. | Cognitive | Medium |
| 5 | This page's visual language differs from the other Operations screens: icon KPI cards, search and Export inside the card header, clickable rows with a link-style "Edit" (:127-155). Employees, Payments and Paperwork use an above-card filter form, an "Open" button column and no row click. Users switching between Ops pages relearn the controls. | Design consistency | Medium |
| 6 | The drawer title is the generic "Facility details" / "Company details" (SiteDrawer.tsx:46). The record name is body text, and the dialog's accessible name doesn't include it. The Overview then repeats Location, Address and Incharges from the header and the list (:93-97). Rent reads "$2,400.00/mo (monthly)" (:100). | Hierarchy | Medium |
| 7 | "Dallas · Dallas" in every row (`facilities-desktop.png`): city and location name are joined even when they're equal (SitesPage.tsx:133). | Visual | Low |
| 8 | The hero KPI values show cents ("$2,400.00", "$4,304.89"). The chart axis uses short money ($4.3k) but the KPI doesn't, so it reads as precise accounting rather than an at-a-glance figure. | Visual | Low |
| 9 | The row Edit linkbtn is 26×17px (measured), and the name linkbtns are 17px tall. Both are below the 24px target and close to each other. The row itself is clickable, but that's not keyboard-reachable as a row. | A11y | Medium |
| 10 | On mobile the drawer tabs wrap to 2 rows (`companies-detail-utilities-mobile.png`). The Utilities table shows only Utility and Account (640/356), so reveal/copy password and Edit are off-screen. | Responsive | High |
| 11 | Dialog footers are "Cancel · Reset · Submit/Save" (UtilitiesTab.tsx:288-290, SiteFormDialog.tsx:209-212). "Reset" next to Cancel is a destructive mis-click risk, and "Submit" is the only generic submit label in the app (others say "Add bill", "Raise invoice"). | Cognitive | Low |
| 12 | The open site isn't routed (local `openId`, SitesPage.tsx:40). You can't link to a facility's Bills tab. | Efficiency | Low |
| 13 | The charts sit below the list. On a full page (`facilities-desktop-full.png`) about 550px of charts follow a 1-row list. That's fine for 1 facility, but the "Bills total by facility" table repeats the per-site total that the list could carry as a column. | Hierarchy | Low |

## Recommended redesign
### Desktop
- List: add "Bills (12 mo)" as a `num` column (from `summary.byOwner`) and drop the separate "Bills total by …" card. Show "City" only when it differs from the location. Pass `q` to the export (needs `?q=` support on `/export.csv`; if the API lacks it, label the button "Export all").
- Align with the other Ops pages: keep the row click, but put the name as a real link and Edit in a `rowactions` `btn sm` (≥ 30px). Make the KPI icon cards the shared pattern for all Ops pages (Payments tiles already similar), or drop the icons. Pick one and use it everywhere.
- Drawer: title = site name + status, with the address subline. Overview shows only what isn't in the header (rent with frequency once, capacity, beds/baths, lease, owner contact, notes, added).
- Bills tab: a month filter (default the last 3 months) plus pager. Columns: Utility (provider in the title attr), Period ("Nov 1–30"), Due (`DueDate`), Amount (num), Status, Invoice (status badge: Scanning / Ready / Rejected / Missing with an inline Upload button), then an overflow menu (Download, Void).
- Upload: a row-level progress state ("Uploading 40%", reusing `storage.post`'s progress callback as in DataHub) and a neutral info banner, not the green `.livemsg`.
### Mobile
- The drawer becomes a full-screen sheet. Tabs scroll horizontally on one row.
- Bills and Utilities as cards: "Electricity · $161.87 · due Dec 15 [Due]", then 44px action buttons (Upload invoice, Reveal/Copy).
### Reusable components
- Existing: `Drawer`, `PillTabs`, `Kpi`, `StatusPill`/`BillStatusPill`, `ConfirmDialog`, `StepUpDialog`, `TrendChart`, `PieShare`.
- New shared: `FileStatusBadge` (pending/clean/rejected; shared with DocumentsSection and DataHub `StatusPill`), `UploadProgress`, `DueDate`, `ResponsiveTable`. Also distinct `.livemsg` variants (`info` vs `ok`).

## Before/after interaction comparison
| Task | Before | After |
|---|---|---|
| Upload this month's water bill invoice | Open site → Bills → scroll 36 rows → scroll sideways → Upload icon → pick file; no scan feedback until download | Open site → Bills (last 3 months) → "Upload" in Invoice cell → progress → "Ready" badge |
| Export the filtered list | Export downloads everything (silently) | Export matches the search, or is labelled "Export all" |
| Copy a utility password on a phone | Swipe the table sideways → reveal → copy | Card → Reveal → Copy (44px buttons) |

## Expected benefit
The bills workflow, the recurring monthly task, becomes bounded and confirmable. Invoice scan outcomes become visible. The Ops pages read as one product.

## Implementation complexity: M
SitesPage.tsx, SiteDrawer.tsx, BillsTab.tsx, UtilitiesTab.tsx, styles.css. Possible API changes: `q` on `/companies|facilities/export.csv`, a date range or cursor on `/bills`, and invoice scan status in the `Bill.invoice` payload (sitesApi.ts:121 has only `documentId` and `fileName`). Without those: client-side month grouping and an "Export all" label.

## Scorecard
| Dimension | Score | Evidence |
|---|---|---|
| Usability | 6 | List and charts are clear; bills workflow unbounded, upload outcome invisible (#1, #2) |
| Visual hierarchy | 7 | Strong KPI/list/chart order; redundant Overview and title (#6) |
| Efficiency | 5 | 36-row unpaged bills, clipped actions (#1) |
| Responsiveness | 4 | Drawer tables clipped at 390; wrapped tabs (#10) |
| Accessibility | 6 | Labelled search, step-up for secrets, aria-labels on icons; small Edit targets (#9) |
| Design consistency | 5 | Different list pattern from other Ops pages (#5); generic "Submit"/"Reset" (#11) |

## Validation
Visual inspection: desktop 1440 and mobile 390 as locD, list pages and drawer Overview/Bills/Utilities tabs for both kinds. Overflow measured: bills 873/830 (desktop drawer), 873/356 (mobile); utilities 640/356 (mobile); facilities list 899/360 (mobile). Redesign validation: pending (not implemented).

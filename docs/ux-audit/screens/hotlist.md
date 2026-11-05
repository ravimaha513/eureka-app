# Hot List — `/hotlist`
Status: Audited · Redesign proposed
Who / permission: `hotlist:read` (nav.ts:15). Default landing screen for every role that has it (App.tsx:286): recruiters, leads, managers, CEO, interview coaches/leads. Bulk bar needs `candidate:update` or `candidate.visibility:update`; Export needs `report:export`.
Source: `apps/web/src/sales/HotListPage.tsx`, `HotListExtras.tsx` (SavedViews, ExportButton, BulkBar), `ListControls.tsx` (ListFilters, ListFooter), `useCandidateList.ts`, `sales/ui.tsx`, `salesApi.ts`, `App.tsx:284-320,457-468`
Evidence: `hotlist-desktop.png`, `hotlist-desktop-full.png` (ceo), `hotlist-recruiter-desktop.png`, `hotlist-recruiter-mobile.png`, `hotlist-mobile-full.png`, new: `hotlist-bulk-selected-desktop.png`, `hotlist-table-scrolled-desktop.png`, `hotlist-quickview-desktop.png`, `hotlist-quickview-mobile.png`

## Primary objective
A recruiter finds a marketable candidate fast (by tech / status / priority / location / visa), shortlists or re-prioritises several at once, peeks or opens the profile, and returns to the same filtered list.

## What's on screen
- Header: h1 + 1-line subtitle (not in `.pagehead`, unlike Candidates).
- Saved views row: 1 select + "Save current filters…" (+ Rename / Update / Delete when a view is chosen) + status line.
- Filter form (`role=search`): **2 text inputs + 12 selects + Sort select = 15 controls**, always expanded, 4 rows at 1440px, + "Clear filters" when active.
- Export CSV button + hint + status line (ceo; not shown for r1a).
- Bulk bar, **always visible**: "0 candidates selected", Set status select + Apply, Set priority select + Apply, (Set visibility select + Apply for visibility holders), Clear selection — all disabled until a row is checked.
- Table: select column + **13 data columns** (Candidate, Technology, Status, Pri, Team, Lead, Recruiter, Location, Visa, Stay, In person, Phone, Days) + Quick view = 15 columns (HotListPage.tsx:65,94-96). 50 rows/page, cursor pager.
- Quick view drawer: 18 facts + "Open full profile".
- Measured: desktop 1440x900 (r1a) first table row at **y=702** (only 3 rows above the fold, `hotlist-bulk-selected-desktop.png`); mobile 390 first row at **y=1203** (1.4 viewports of controls). Tab stops from h1 to first candidate link: **22**.

## Problems
| # | Problem (evidence) | Category | Severity |
|---|---|---|---|
| 1 | At 1440px the table is 1540px wide inside a 1110px scroller: **Stay, In person, Phone, Days and the Quick view button are off-screen** on every row; the only per-row action needs a horizontal scroll (measured `.tablewrap` client 1110 / scroll 1540; Quick view th right edge x=1837; `hotlist-recruiter-desktop.png` ends at "Visa", `hotlist-table-scrolled-desktop.png`). HotListPage.tsx:94-96,123-125 | Efficiency | Critical |
| 2 | Filters live in React state, not the URL (useCandidateList.ts:141-148). Reloading `/hotlist/<id>` then "Back to Hot List" drops all filters (verified: Status=Active → reload → back → Status empty). Leaving to another screen also resets. App.tsx:291-292 comment claims "the query string … holds that screen's filters" — not true for this screen. Opening/closing a profile without reload does keep filters (list stays mounted hidden, App.tsx:296-310 — good) | Efficiency | High |
| 3 | 15 always-expanded filter controls + saved-view row + bulk bar push results to y=702 desktop / y=1203 mobile. Most-used filters (search, tech, status, priority) have the same weight as Guest house / Resume / Documents. No active-filter summary: once a filter is set the only cue is a select's text among 15 (ListControls.tsx:29-86, `hotlist-bulk-selected-desktop.png`) | Hierarchy | High |
| 4 | Bulk bar always rendered with "0 candidates selected" and 3–4 disabled controls (HotListExtras.tsx:191-231; `hotlist-recruiter-desktop.png`). It costs ~80px above the table and reads as broken/disabled; disabled primary buttons are pale violet and still look clickable | Cognitive | Medium |
| 5 | Selection is cleared on any page change because `filterKey` includes the cursor (HotListPage.tsx:53-56, useCandidateList.ts:173) — shortlisting across pages of 50 is impossible and silently loses picks | Efficiency | Medium |
| 6 | Status cell triple-encodes visibility: "Active" badge + "Open to all teams" badge + small "Active/All Teams" sub-line (HotListPage.tsx:110-111; `hotlist-desktop-full.png`). `SharedBadge` reuses the `all_teams` violet class, so "Selected teams" and "Open to all teams" look identical in colour (ui.tsx:20-21, styles.css:114) | Visual | Medium |
| 7 | Quick view shows status twice: "Active Active" (badge + `statusLabel` printed even without "/"; HotListPage.tsx:139 vs the list's `includes("/")` guard at :111; `hotlist-quickview-desktop.png`) | Visual | Low |
| 8 | Column priorities: Lead (initials like "l1") and Team are redundant (team implies lead); Visa / Stay / In person mostly "—" for the seed set; Phone is masked "•••-25" for most rows a recruiter sees, yet each takes a column, while Days in market is labelled just "Days" (HotListPage.tsx:94-95) | Hierarchy | Medium |
| 9 | Mobile 390: table is a horizontally scrolled grid showing only Candidate + Technology; Status/Priority (the scan keys) are clipped (`hotlist-recruiter-mobile.png`); 12 two-column selects fill the first viewport and a half; no sticky way back to filters | Responsive | High |
| 10 | Keyboard: 22 Tab stops (all filters, saved views, bulk controls) before the first result; no "skip to results" link. Row checkboxes are 13×13px and name buttons 17px tall (measured; passes 2.5.8 only via spacing exception) | A11y | Medium |
| 11 | "Save current filters…" is enabled with no filters set (HotListExtras.tsx:85), and Export sits as a loose row with a long hint between filters and bulk bar (HotListExtras.tsx:128-135; `hotlist-desktop-full.png`) — page-level actions are scattered over 3 rows | Hierarchy | Low |

## Recommended redesign
### Desktop
1. **Page head** (`.pagehead`): h1 "Hot List" + result count; right side: Saved view select (as a compact "Views ▾" menu with Save / Rename / Update / Delete inside) and Export CSV (hint moves into a `title`/describedby). Subtitle shortened to one clause about masked phones.
2. **Filter bar, one row**: Search name · Technology · Status · Priority · Location (the 5 most decisive) + **"More filters (n)"** button opening a popover/side panel with Visibility, Visa, Documents, Resume, Stay, Team, Recruiter, In person, Guest house. Sort moves to the right end of the bar ("Sort: Default ▾").
3. **Active-filter chips** row under the bar ("Status: Active ×", "P1 ×", "Clear all") — only when filters set.
4. **Bulk bar replaces the chip row only while ≥1 row is selected** (sticky top of table): "2 selected · Set status ▾ · Set priority ▾ · Visibility ▾ · Clear". Each "Set …" is a menu that applies on pick (no separate Apply button); result line stays as today.
5. **Table — 8 columns that fit 1110px**: ☐ · Candidate (name + technology as second line) · Status (single badge; visibility as a small icon+text "All teams"/"Shared" in the same violet only for all_teams, a neutral outline for selected teams; drop the "Active/All Teams" sub-line) · Pri · Team (lead in `title`/second line) · Recruiter · Location · Days in market · Quick view (icon button, always visible, right-aligned, `position: sticky; right:0`). Visa / Stay / In person / Phone move to Quick view (they're already there) and are available as filters.
6. **URL state**: serialise filters + sort + page cursor into `?` query (App.tsx `go()` already preserves `location.search` within a screen), so reload, back/forward and shared links keep the list.
7. Keep selection across pages (store ids in a Set not reset by cursor; reset only on filter change) and show "n selected (across pages)".

### Mobile
- Search name full-width + "Filters (n)" button opening a **bottom sheet** with all filters + Sort + "Show results" (sticky footer). Chips row scrolls horizontally.
- Rows become **cards**: name + priority badge on line 1, status badge + technology + location on line 2, Days in market + Quick view on line 3; checkbox 24px hit area on the left only when a "Select" toggle is on.
- Bulk bar as a sticky bottom action bar when selection > 0.
- Target: first result within the first viewport (≤ 300px from top).

### Reusable components
- Existing: `Drawer` (sales/ui.tsx:69) for More filters & bottom sheet (add a `side="bottom"` variant), `StatusBadge`, `Priority`, `ListFooter`, `.pagehead`, `.toolbar`.
- New shared: `FilterBar` (primary fields + More disclosure + chips), `FilterChips`, `SelectionBar`, `useUrlListState` (replaces state in useCandidateList.ts), `ResponsiveTable` card mode via CSS (`@media (max-width:640px)` + `data-label`). All reused by Candidates (same `ListFilters`) and other list screens.

## Before/after interaction comparison
| Task | Before | After |
|---|---|---|
| See a candidate's Days in market / open Quick view (desktop) | scroll table horizontally, then click (2+ actions per row) | visible in row, 1 click |
| Filter to "Active, P1, Java" | 3 controls among 15 (2 selects + type), find them in a 4-row grid | 3 controls in the first row; chips confirm |
| Bulk-set priority on 3 rows | check 3 → choose in select → Apply (5 actions) | check 3 → Set priority ▾ → P2 (5 → 5 actions, but bar appears only in context and no disabled clutter) |
| Shortlist from page 1 and page 2 | impossible (selection lost on Next) | check, Next, check, apply |
| Open profile, reload, return to list | filters lost; re-enter or pick saved view | filters restored from URL |
| Reach first result by keyboard | 22 Tabs | ≤ 8 Tabs (5 primary filters + More + Sort + Views) or skip link |
| Mobile: see first result | scroll ~1200px | visible on load |

## Expected benefit
Recruiters (largest user group, landing page) see ~12 rows above the fold instead of 3, can act on every visible row without horizontal scroll, and do not lose their working set on reload. Fewer visible controls cut scan time; contextual bulk bar removes the "everything disabled" impression.

## Implementation complexity: M
Files: HotListPage.tsx, HotListExtras.tsx, ListControls.tsx, useCandidateList.ts, sales/ui.tsx, styles.css (hot file — merge main first). New FilterBar/SelectionBar components. **No API changes** (all filters/bulk endpoints exist; URL state is client-side).

## Scorecard
| Dimension | Score | Evidence |
|---|---|---|
| Usability | 4 | Critical #1 (row action off-screen), High #2 (filters lost on reload) |
| Visual hierarchy | 4 | #3, #6, #8: 15 equal-weight controls, triple status encoding |
| Efficiency | 4 | #1, #2, #5; first row at y=702 |
| Responsiveness | 3 | #9: only 2 columns visible at 390, first row at y=1203; no page overflow though |
| Accessibility | 6 | Good: labelled fields, `role=search`, live result count, focus returns to opener. Medium #10 (22 Tab stops, 13px checkboxes) |
| Design consistency | 5 | Header not `.pagehead` (vs CandidatesPage.tsx:32); same colour for two visibility states; Apply-button pattern differs from profile's menu pattern |

## Validation
Visual inspection: desktop 1440 and mobile 390 as ceo and r1a (existing + new screenshots), measured table scroll widths, first-row offsets, Tab count, touch targets, overflow (none at 390), filter persistence across profile open/close and reload. Redesign validation: pending (not implemented).

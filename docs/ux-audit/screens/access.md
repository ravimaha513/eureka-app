# Users & Access — `/access`
Status: Audited · Redesign proposed · Implemented (rebrand wave 2)
Who / permission: `access:manage` (nav.ts:46) — org admin
Source: `apps/web/src/admin/AccessPage.tsx`, `UsersTab.tsx` (757 lines), `ApprovalsTab.tsx`, `TeamsTab.tsx`, `TeamDrawer.tsx`, `LocationsTab.tsx`, `LocationDetail.tsx`, `RolesTab.tsx`, `OrgChartTab.tsx`
Evidence: `access-desktop.png`, `access-desktop-full.png`, `access-mobile.png`, `access-mobile-full.png`, new: `access-users-action-desktop.png`, `access-users-mobile-scrolled.png`, `access-users-mobile-row.png`, `access-approvals-desktop-full.png`, `access-teams-desktop-full.png`, `access-teamdrawer-desktop.png`, `access-locations-desktop-full.png`, `access-locationdetail-desktop-full.png`, `access-roles-desktop-full.png`, `access-orgchart-desktop-full.png`

## Primary objective
The admin finds a person fast and changes their access (grant/revoke role, team, manager, deactivate). Secondary: approve restricted-role requests, maintain teams/locations/roles and the reporting line.

## What's on screen
- Tablist (6 tabs, with arrow-key support, AccessPage.tsx:35-44) and a live region.
- **Users**: 14 role-count tiles (3 rows), a filter block (search + 5 selects: Status, Department, Team, Role, Location), Departments / Import users / New user, a table with 10 columns (select, User, Designation, Department, Phone, Status, Roles with × revoke chips, Teams, Manager, Actions with up to 6 buttons: Grant role, Email invite, Set password, Manager, Department, Deactivate), a cursor pager, and a bulk bar (Add to team / Move to team / Clear).
- **Approvals**: Show select, a 4-col table (empty in the seed).
- **Teams**: filter, "14 active people have no team. Assign them", cards; drawer with members, coaches, an add-people picker.
- **Locations**: cards → detail with 3 stats, location roles, a People view switch (Hierarchy/By team/By role).
- **Roles**: per-track tables (Level, Role+badges, Traits, Holders, Permissions, Open, Clone).
- **Org chart**: drag/drop tree, find, Expand all, pending-changes panel, selected-person panel.

## Problems
| # | Problem (evidence) | Category | Severity |
|---|---|---|---|
| 1 | The Users table starts below the fold at 1440×900. 14 role tiles (UsersTab.tsx:113) plus 2 rows of filters push the first row to y≈880 (`access-desktop.png`); on mobile it's ~y=1500 (`access-users-mobile-row.png`). The tiles aren't clickable filters, so they're informational only. | Hierarchy / Efficiency | High |
| 2 | Row actions are off-screen. With 10 columns (L175) the Teams/Manager/Actions columns only appear after horizontal scroll at 1440 (`access-desktop-full.png` ends at "Roles"; `access-users-action-desktop.png` shows them after scrolling). Every row repeats 6 buttons (L208-217), 126 buttons for 21 users, with **Deactivate** (danger) at the far right of each row. | Efficiency / Visual | High |
| 3 | Revoke is a "×" inside the role chip at 18×18px (L196; 21 instances measured <24px at 390) with an `aria-label` but no visible label. It's easy to mis-hit next to the chip text. (The confirm dialog mitigates, so this is not Critical.) | A11y | Medium |
| 4 | 5 filter selects + search wrap into 2 uneven rows, and the action buttons get pushed onto the second filter row (`access-desktop.png`). Nothing shows which filters are active and there's no Reset. | Efficiency | Medium |
| 5 | The Approvals tab shows no pending count, although `.tab .tabcount` exists (styles.css:1045). The second admin can't see that something is waiting without opening the tab (AccessPage.tsx:52-56). | Efficiency | Medium |
| 6 | Roles: each track is its own table (RolesTab.tsx:54-56), so column x-positions jump between groups (Traits at x≈775/833/813/819…, `access-roles-desktop-full.png`). Hard to scan Holders/Permissions down the page. "Hr" track label is mis-cased. | Visual | Medium |
| 7 | Org chart: the "Find a person" input is unstyled (thin native border, no `.field`/search styling, OrgChartTab.tsx:234; `access-orgchart-desktop-full.png`). Team members are shown twice (as a chip group in the green Team box and again as cards right below). | Visual / Cognitive | Medium |
| 8 | Locations: "1 people" (LocationsTab.tsx:43, `access-locations-desktop-full.png`). | Copy | Low |
| 9 | Team drawer: the add-people picker defaults to "No team" and lists CEO, AD, managers, HR, Accounts (`access-teamdrawer-desktop.png`). These are people who should never join a sales team, so the list is long and mostly noise. | Efficiency | Low |
| 10 | Mobile Users: 187 interactive elements, 186 under 44px tall; 21 row checkboxes at 13×13 and 4 phone links at ~17px tall (Playwright measurement). | Responsive / A11y | Medium |

## Recommended redesign
### Desktop — Users
1. Collapse the 14 tiles into one horizontal chip row "Org Admin 2 · HR 1 · … · Recruiter 4", where each chip applies the Role filter. Saves ~430px; the table starts at ~y=300.
2. Filter bar: search + "Role", "Status" visible; Department/Team/Location under "More filters". Active-filter chips with × and "Reset".
3. Table: User (name, email, designation as a muted line), Roles (chips), Team, Manager, Status, ⋯. Drop the Department and Phone columns from the default view (Phone is contact data, available in the row drawer). One primary per row: **Grant role**; everything else (Email invite, Set password, Manager, Department, Deactivate) goes in an `OverflowMenu`, with Deactivate last and separated. Fits 1440 without horizontal scroll.
4. Revoke: chips open a small popover "Revoke <role>" (target ≥24px), or revoke from the row drawer.
5. Approvals tab: `tabcount` badge with the pending number (reuse the existing CSS).
### Other tabs
- Roles: one table with track group-header rows (`<tbody>` per track with a `<th colspan>` header), so columns line up.
- Org chart: style the search like the Teams filter (`.search` input with icon); remove the duplicate member chips inside the team box (keep the box as a drop target header only).
- Team drawer: default the picker to "No team · Sales roles".
### Mobile
User rows as cards: avatar, name, roles chips, status, ⋯ menu (≥44px). Role chip row scrolls horizontally. Filters go in a bottom sheet (reuse the Dashboard `FilterSheet` pattern, DashboardPage.tsx:121-153).
### Reusable components
Existing: `.tabs` + AccessPage keyboard model (extract to `useTablist`), `.tabcount`, `FilterSheet` pattern, `Pager`. New shared: `<OverflowMenu>` (also wanted by training-batch, courses), `<FilterChips>`.

## Before/after interaction comparison
| Task | Before | After |
|---|---|---|
| Find r1a and grant a role (desktop) | Scroll past tiles → type search → scroll table right → Grant role (≈4 actions + 2 scrolls) | Type search → Grant role (2 actions, no scroll) |
| Deactivate a user | Scroll right, find red button among 6 | ⋯ → Deactivate (separated) → confirm |
| See pending approvals | Open Approvals tab | Badge visible on tab |
| Filter by role | Open Role select, pick | Click role chip |

## Expected benefit
The core admin task fits in one viewport with no horizontal scroll. ~100 fewer buttons on the page lowers the risk of a destructive mis-click. Approvals stop sitting unnoticed.

## Implementation complexity: M–L
UsersTab.tsx (largest change: tiles, filters, columns, menu), AccessPage.tsx (badge; needs the pending count, which is available if ApprovalsTab's query is lifted, so no API change), RolesTab.tsx, OrgChartTab.tsx, LocationsTab.tsx copy, new OverflowMenu. No API change.

## Scorecard
| Dimension | Score | Evidence |
|---|---|---|
| Usability | 5 | Core task needs scrolling in 2 directions (#1, #2) |
| Visual hierarchy | 4 | Tiles dominate; table below fold (#1) |
| Efficiency | 4 | 126 repeated buttons, hidden actions, no filter reset (#2, #4, #5) |
| Responsiveness | 4 | Table starts at ~1500px on mobile; tiny targets (#10) |
| Accessibility | 6 | Good tablist and labels; 18px revoke and 13px checkboxes (#3, #10) |
| Design consistency | 5 | Unstyled org-chart search, misaligned role tables (#6, #7) |

## Validation
Visual inspection: admin at 1440 for all 6 tabs plus team drawer, location detail and the row-action state; Users at 390 (two scroll positions). Target sizes measured with Playwright at 390. Redesign validation: pending (not implemented).

### Implemented (wave 2)
| Audit item | Change | Evidence |
|---|---|---|
| #1 Table below the fold (High) | 14 role tiles → one row of role toggle buttons with counts (`aria-pressed`, apply the Role filter); "14 active · 1 inactive" summary. First row at y≈430 (was ≈880). | `after/access-desktop.png` |
| #2 Row actions off-screen, 6 buttons per row, Deactivate far right (High) | Table rebuilt as a kit `.dtable`: User, Designation+department (p2), Roles, Team+"Reports to" manager, Phone (p3), Status, actions. One **Grant role** (or **Reactivate**) button + kit `Menu` (Email password link, Set temporary password, Set manager, Set department, then **Deactivate…/Delete now…** last in bad red, still confirmed). Fits 1440 with no sideways scroll. | `after/access-desktop.png`, `after/access-menu-desktop-dark.png` |
| #3 18px revoke × (Medium) | Revoke is a 24px target (32px on phones) with an X icon, a title and the same aria-label; confirm dialog unchanged. | `after/access-desktop.png` |
| #4 Filters wrap, no active-filter state, no reset (Medium) | Kit `FilterBar`: Search, Role, Status inline; Department, Team, Location under "More filters · n" with removable chips and "Clear filters". All filters in the URL (`?role=&team=…`); Teams "Assign them" sets `team=none&status=active`. Page actions (Departments, Import users, New user) sit at the right of the filter row. | `after/access-desktop.png` |
| #5 Approvals tab has no pending count (Medium) | Kit `Tabs` (roving tabindex, `?tab=`); Approvals shows the pending count (`.tabcount`, name "Approvals, pending: n"), sharing the Approvals tab's query cache. | `after/access-approvals-desktop.png` |
| #6 Roles columns jump between tracks, "Hr" (Medium) | Track tables share fixed column widths (Traits/Holders/Permissions line up, numbers right-aligned); `trackLabel` upper-cases HR/IT/BGC. | — |
| #7 Org-chart find unstyled; team members shown twice (Medium) | Find uses the Teams `.searchfield` (icon, label). Team strip chips only members who don't report to the lead; the rest are counted as "shown below as cards". | — |
| #8 "1 people" (Low) | "1 person", "1 team". | — |
| #10 Mobile targets (Medium) | Rows become record cards: name + status, roles, team; Grant role + ⋯ at 40px; 20px checkboxes; filters in the bottom sheet; role toggles scroll sideways inside their own strip. | `after/access-mobile.png`, `after/access-filters-mobile.png` |
| #9 Team drawer picker (Low) | Not changed (TeamDrawer behaviour kept). | — |

Validation (wave 2, 2026-11-05): `pnpm --filter @eureka/web typecheck` clean; full web unit suite 552/552 (admin, staff, training, team suites updated only where markup/interaction changed). Visual check at 1440×900 and 390×844, light and dark, in Playwright against a fixture API built from the `*Api.ts` shapes, because the shared API on :3000 and its Postgres were not running in this environment. Page width at 390 = 390 on every screen below; row actions visible at 1440. Live-data re-check against the seeded API is still owed.

# Placements — `/placements`
Status: Audited · Redesign proposed · Implemented (rebrand wave 2)
Who / permission: `placement:read` (nav.ts:19): recruiters (own), leads, managers, CEO, HR, accounts, immigration. "Cleared interviews" tab needs `interview:read`. Export needs `report:export`.
Source: `apps/web/src/pipeline/PlacementsPage.tsx` (list, lines 67-258), `pipeline/ClearedInterviews.tsx`, `pipeline/ui.tsx`, `pipelineApi.ts`; routing `App.tsx:473`. Detail drawer: see `placement-detail.md`.
Evidence: `placements-desktop.png`, `placements-desktop-full.png`, `placements-mobile.png`, `placements-mobile-full.png`

## Primary objective
Track confirmed offers through paperwork, BGC and joining. Find placements that need attention (overdue paperwork, upcoming starts) and open one to act.

## What's on screen
- Header + description; tabs "Placements | Cleared interviews".
- Filters: 8 status chips + All, Candidate, Created from/through, Batch, End client, Technology, Team, Location, conditional Clear filters (up to 16 controls), Export CSV with an explanation line.
- Table: 7 columns (Candidate + First placement / Re-confirmed badges + technology, Client/vendor, Type + mode + city, Start, Status, Recruiter/team, Rate) + "Open". Cursor pager.

## Problems
| # | Problem (evidence) | Category | Severity |
|---|---|---|---|
| 1 | The list doesn't show what needs action. Paperwork progress, BGC state and overdue items exist on the record (`ChecklistProgress`, `PlacementsPage.tsx:52-62`), but they aren't in the row. HR and accounts must open each placement to find overdue paperwork. The table has no sort, and starts are not ordered by soonest (`placements-desktop.png`). | Efficiency / Hierarchy | High |
| 2 | Filters are "Created from/through" (`:178-185`), not the tentative or actual start date, which is the date ops plan around. There is no "starting this week" or "overdue" quick filter. | Efficiency | Medium |
| 3 | There are no links to related records. The candidate name is plain `<b>` (`:227`), and there's no link to the originating submission or interviews (`placements-desktop.png`). | Efficiency | Medium |
| 4 | "First placement" badge on nearly every row (6 of 8 rows in `placements-desktop.png`). A badge that appears on almost every row tells the reader nothing and clutters the Candidate column. | Visual | Low |
| 5 | Mobile: table 990px in 360px (measured). Status and Open are off-screen at 390px (`placements-mobile.png`). 16 filter controls push data below the first screen. | Responsive | High |
| 6 | The status filter uses `StatusChips` without counts (`:174`), so the user can't see "3 in Paperwork" without clicking. | Efficiency | Low |
| 7 | Tabs: the "Placements/Cleared interviews" tablist has `role="tab"` but no arrow-key handling or roving tabindex (`:153-158`). Every tab is a tab stop, unlike the ARIA tabs pattern. Shared with Interview reports. | A11y | Low |

## Recommended redesign
### Desktop
- Add a "Next step" column computed from existing fields: "Paperwork 0/1 · 1 overdue" (red), "BGC initiated", "Starts in 3 days", "Joined Nov 16". Make Start sortable (asc default for open statuses).
- Change the date filter label and param to "Start from/through" if the API supports it. If not, keep Created but add quick chips "Starting this week" / "Overdue paperwork" **only if the API already filters them**. Otherwise defer (API change).
- Show "First placement" as a small icon/tag only when `isFirstPlacement && reconfirmed===false`, or move it to the drawer.
- Candidate name links to the candidate; the row opens the drawer (whole row clickable plus the existing Open button for keyboard users).
- Chip counts from a summary query (needs an API count endpoint, or reuse the list total per status: **API change, optional**).

### Mobile
- Card per placement: candidate, client, status badge, next-step line, start date. Filters in a sheet; status chips as a horizontal scroll row.

### Reusable components
Existing: `StatusChips`, `PipelineStatus`, `Pager`, `useSearchParam`. New shared: `ResponsiveTable`, `FilterBar` (collapsible), `RecordLink`, `Tabs` (proper ARIA tabs, shared with Interview reports).

## Before/after interaction comparison
| Task | Before | After |
|---|---|---|
| Find placements with overdue paperwork | Open each placement, read checklist (N × 2 clicks) | Scan Next-step column (0 clicks) |
| Who starts this week | Filter can't; scan Start column across pages | Sort by Start = 1 click |
| Check a placement on mobile | Scroll table sideways to Open = 2+ gestures | Tap card = 1 |

## Expected benefit
Ops and HR roles can triage straight from the list instead of opening records one by one. The mobile view becomes usable.

## Implementation complexity: M
`PlacementsPage.tsx`, `styles.css`. Next-step column needs `checklist`/`bgc` on list items. They are present on the full record (`PlacementsPage.tsx:369`) but probably not on list rows, so a list summary field is likely an **API addition**; verify `Placement` list payload. Sort and start-date filter may also need API params.

## Scorecard
| Dimension | Score | Evidence |
|---|---|---|
| Usability | 6 | Clear filters, export with limits explained; triage requires opening records (#1) |
| Visual hierarchy | 6 | Clean table; badge noise; no urgency signal (#1, #4) |
| Efficiency | 5 | No next-step, no sort, wrong date dimension (#1, #2) |
| Responsiveness | 3 | 990px table at 390 (#5) |
| Accessibility | 7 | Labeled filters, aria-labels on Open, tabs pattern incomplete (#7) |
| Design consistency | 7 | Matches Submissions list patterns |

## Validation
Visual inspection: existing desktop and mobile screenshots; table width measured at 390 (990/360) and 1440 (fits). Redesign validation: pending (not implemented).

### Implemented (wave 2)
| Audit item | Change | Evidence |
|---|---|---|
| #1 list doesn't show what needs action (High) | Start cell adds `Starts in N days` (warn when ≤7) / `Start date passed`; paperwork progress per row needs the checklist on the list endpoint (API change, deferred); no server sort (deferred) | `after/placements-desktop.png` |
| #2 created dates, no quick filters (Medium) | Kept Created from/through (the API filters by creation only); quick filters deferred (API) | — |
| #3 no links (Medium) | Candidate → profile (RecordLink); drawer links candidate, source submission (App prop) and Paperwork & BGC | — |
| #4 First placement on most rows (Low) | Quiet outlined tag in the row; the violet chip stays in the drawer | Placements.test |
| #5 phone overflow, 16 controls (High) | `dtable` cards; FilterBar (Candidate, Status, dates inline; Batch, Vendor, End client, Technology, Team, Location under More filters / the phone sheet) | `placements-mobile.png` |
| #6 chips without counts (Low) | Status is a select (no count endpoint for placements; not invented) | — |
| #7 tabs without ARIA keyboard (Low) | Kit `Tabs` with `?view=cleared` | Placements.test (cleared tab) |

**Validation (wave 2):** `pnpm --filter @eureka/web typecheck` clean; `vitest run src/pipeline src/interviews src/pipelinereport` 103/103 (tests updated only where markup intentionally changed: status selects instead of chip groups, row menus, the shared scheduling form, `More filters` disclosure). The shared API on :3000 was down during this wave (no Postgres or Docker in the session), so the after-shots were taken against the branch's Vite build with Playwright route fixtures shaped like the API (fictional data, read-only). Checked at 1440x900 and 390x844 in light and dark: `document.documentElement.scrollWidth` = 390 on phones, row actions inside the viewport at 1440 (`td.c-act` right edge 1411). E2E specs not run (they create records and need the live API).
After: `../screenshots/after/placements-{desktop,mobile}.png`

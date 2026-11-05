# Dashboard — `/dashboard`
Status: Audited · Redesign proposed · Implemented (rebrand wave 2)
Who / permission: `report:read` (nav.ts:14) — CEO, managers, leads, recruiters, location ops
Source: `apps/web/src/dashboard/DashboardPage.tsx`, `apps/web/src/ui/Charts.tsx`, `apps/web/src/styles.css:464-475, 505-512, 1101-1166`
Evidence: `dashboard-desktop-full.png`, `dashboard-mobile-full.png`, `dashboard-recruiter-desktop.png`, `dashboard-recruiter-mobile.png`, `dashboard-legend-focus-desktop.png` (new), `dashboard-trend-tooltip-desktop.png` (new), `dashboard-filtersheet-mobile.png` (new)

## Primary objective
Recruiters, leads and managers open this to see **what needs action now** (stale submissions, interviews without feedback, stalled placements), then how activity is trending for their scope.

## What's on screen
- Header: range pill, 3-way period segmented control, Group-by select, Export CSV (with `report:export`).
- 6 KPI tiles with % delta vs previous period.
- 7 chart/summary cards: Activity trend (area chart + 6 legend toggles), Activity by <group> (top-5 rank bars), Needs attention summary (3 jump links), Pipeline funnel, Activity mix donut, Share by <group> donut (+6 metric chips), Needs attention donut.
- Group table (7 cols), then "Needs attention" heading with 3 tables (5 cols + Open), up to 18 rows in the seed.
- CEO page height 3755px desktop / 4598px mobile. Needs-attention tables start at ~y=2050 desktop (CEO) and ~y=1990 (recruiter).

## Problems
| # | Problem (evidence) | Category | Severity |
|---|---|---|---|
| 1 | Actionable work is buried. The three "needs attention" tables (the only place with **Open** buttons) come after 4 decorative charts, the group table and the funnel: DashboardPage.tsx:434 is the last block. In `dashboard-recruiter-desktop.png` they start ~2 viewports down. The summary card (L353-376) only jumps there. | Hierarchy | High |
| 2 | "Needs attention" shows up 3 times: summary card (L353), donut (L402-408), tables (L434). The donut adds nothing beyond three counts already shown with their labels. | Cognitive | Medium |
| 3 | The funnel is not a funnel. `FUNNEL` (L35) plots period event counts, not a cohort, so stages can grow: CEO shows Interviews cleared 3 → Placements 6, and the recruiter shows Cleared 0 → Placements 2. The band then widens (`dashboard-desktop-full.png`, `dashboard-recruiter-desktop.png`), implying conversion that didn't happen. `FunnelBars` also has a minimum half-height of 8 (Charts.tsx:102), so 0 is still drawn as a band. | Visual / honesty | High |
| 4 | The "Activity mix" donut adds up incompatible units ("184 events" = submissions + interviews + … + 156 candidates added, L387-388). One metric takes ~85% of the ring, so the other five are slivers. A part-to-whole chart doesn't fit unrelated counts. | Visual / honesty | Medium |
| 5 | Trend curve: checked. `type="monotone"` (Charts.tsx:58) is monotone-X, so it does **not** overshoot data points (the initial observation is only half right). It still draws smooth slopes between daily buckets, which implies fractional values (e.g. 2.5 interviews at noon Nov 3), and with `dot={false}` you can't tell which points are real. The 7-day view has only 7 points. | Visual / honesty | Medium |
| 6 | Legend toggles look disabled. Unpressed items get `opacity:.5` on `--muted` (styles.css:1112), about 2:1 contrast on white, which fails WCAG 1.4.3. They read as greyed out, not "off" (`dashboard-legend-focus-desktop.png`). Only 3 of 6 series show by default (L217), so half the legend looks broken. | A11y / Visual | High |
| 7 | Delta honesty. When the previous period was 0, the tile shows a green up-arrow "New" (L60), e.g. "Candidates added 156 · New". That's neither a % nor an absolute change. Small bases inflate (Placements 2→6 = "+200%"), and there's no absolute delta. "vs previous 7 days" shows only on tile 1 (L58, L292); on mobile it's hidden everywhere (styles.css:1156). | Cognitive | Medium |
| 8 | Tile colours don't match series colours. Tiles use the `TILE` tints (L45-52: Interviews=rose, Placements=amber, Cleared=teal), but the chart uses `PALETTE[index]` (L311, L316: Interviews=teal, Cleared=amber, Placements=rose). Same metric, different colour, on one screen. | Cognitive | Medium |
| 9 | The "Activity by location" card is mostly empty. `.dashrow.wide` stretches the card to the trend height and `.ranklist` uses `justify-content: space-evenly` (styles.css:1107-1108), so 2 rows spread over ~280px (`dashboard-desktop-full.png`, `dashboard-recruiter-desktop.png`). | Visual | Medium |
| 10 | The group views repeat each other. The rank list (L319), Share donut (L390) and group table (L413) all show the same per-group numbers. For a recruiter, Group by = Recruiter gives 1 row, so 3 widgets show "r1a 2" (`dashboard-recruiter-desktop.png`), and the group table has no heading (only `aria-label`). | Efficiency | Medium |
| 11 | Mobile: in the needs-attention tables, Status / Recruiter / Waiting / **Open** are off-screen in horizontal scroll (`dashboard-mobile-full.png`), so the primary action can't be seen on a phone. | Responsive | High |
| 12 | The "View all" link target is 65×15px (Playwright measurement at 390px). That's under 24px, a WCAG 2.5.8 fail. | A11y | Medium |
| 13 | The age bar uses only 2 colours (amber <14d, red ≥14d, L458) and the scale caps at 30 days. Everything in the seed is red/amber, so the bar has no signal. The number already says it. | Visual | Low |

## Recommended redesign
### Desktop
1. Order: header → KPI tiles → **Needs attention** (tabs or three stacked compact tables, each with Open, first 5 rows + "Show all N") → Trend → Group table. Remove the Needs-attention summary card and donut; move each count into its table's heading as a badge.
2. Trend: `type="linear"` (or `step`) with `dot` on each day for ≤31 points, and bars for 90 days. Legend items: full-contrast text, with "off" shown by a hollow swatch plus `aria-pressed`, not by opacity.
3. Replace the funnel with "Stage counts this period" horizontal bars (no necks) labelled "events in period, not a cohort". Or keep the funnel only if the API returns cohort conversion (it doesn't today, so drop it).
4. Remove the Activity-mix donut. Fold "Share by group" into the group table as an inline bar column (the rank-list visual) and remove the separate rank card. This fixes the empty-space card.
5. Delta: show absolute and % (`+4 (+200%)`). When the base is 0 show `+156 vs 0`, in neutral colour. Show a single "vs previous 7 days" caption above the tile row.
6. One colour map: tile tint = series colour (derive both from one `METRIC_COLOR` record).
7. When the scope has a single group (recruiter), hide Group-by and the group table.
### Mobile
- Needs-attention rows as stacked cards: name + detail on line 1, status · waiting on line 2, whole row tappable (Open). No horizontal scroll.
- KPI tiles keep the 3-column layout. Show the delta caption once.
### Reusable components
Existing: `TrendChart`, `.tiles`, `.tabs.seg`, `FilterSheet` (good). New shared: `<DeltaBadge abs pct base>` (reusable by Performance/Reports), `<RowCardList>` responsive table→card pattern, `METRIC_COLOR` map in Charts.tsx.

## Before/after interaction comparison
| Task | Before | After |
|---|---|---|
| Recruiter opens oldest stale submission (desktop) | Scroll ~2 viewports or click summary row → find row → Open (2 actions + scroll) | Visible above fold → Open (1 click) |
| Same on mobile | Scroll ~4000px, scroll table sideways, tap Open | Scroll 1 screen, tap card |
| Read "did placements improve?" | Read tile %, guess base | Read "+4 (+200%) vs prev 7 days" |
| Plot "Placements" on trend | Find greyed-out chip (looks disabled), click | Click a clearly-labelled toggle |

## Expected benefit
Recruiters reach the action list right away. The funnel and mix charts stop overstating conversion and share. Page height drops ~45% (removes 4 cards).

## Implementation complexity: M
DashboardPage.tsx reorder/removal, Charts.tsx (`TrendChart` curve prop + dots, removing or relabelling FunnelBars), styles.css (legendtabs, ranklist). No API change.

## Scorecard
| Dimension | Score | Evidence |
|---|---|---|
| Usability | 5 | Works, but the core action is buried (#1) |
| Visual hierarchy | 4 | 7 equal-weight cards ahead of the work queue; misleading funnel/mix (#1, #3, #4) |
| Efficiency | 5 | Triplicated info (#2, #10) |
| Responsiveness | 4 | Open button off-screen in scroll on mobile (#11), 4598px page |
| Accessibility | 5 | Good text alternatives and sr-only hints, but legend contrast fails AA (#6), small target (#12) |
| Design consistency | 5 | Tile/series colour mismatch (#8) |

## Validation
Visual inspection: CEO and recruiter at 1440 and 390 (existing + new shots), legend keyboard focus, chart tooltip, mobile filter sheet; mobile overflow measured (none at page level; tables scroll internally). Redesign validation: see wave 2 below.

### Implemented (wave 2)
| Audit item | Change | Evidence |
|---|---|---|
| #1 Work buried (High) | "Needs attention" is now the first block: one card with three lists (oldest first, 5 rows + "Show all N"), and each row has Open | `after/dashboard-desktop.png` (Open buttons at y≈311, x 1319–1394) |
| #2 Needs attention ×3 | Summary card and donut removed. Each list heading carries its count and the section head carries the total | `after/dashboard-desktop.png` |
| #3 Funnel not a funnel (High) | Replaced by "Pipeline activity in the period" bars, labelled "events counted in the period, not a cohort". A 0 draws no bar | `after/dashboard-desktop.png`; unit test "no bar for zero" |
| #4 Activity-mix donut | Removed (mixed units) | — |
| #5 Smoothed trend | Local `DailyTrend`: straight lines between real days, a dot per day up to 31 points, chart tokens | `after/dashboard-desktop.png` |
| #6 Legend contrast (High) | Kit legend: an off item is a hollow dot with `--muted` text, readable contrast, `aria-pressed` | `after/dashboard-dark-desktop.png` |
| #7 Delta honesty | Absolute + percent (`−8 (−38%)`). When the previous period was 0 it shows "New · prev 0" in muted ink. Decreases use neutral ink, never red. One "Change vs previous 7 days" caption | `after/dashboard-desktop.png` |
| #8 Tile/series colours | One `METRIC_COLOR` map (chart tokens) for tile swatch, legend, line and bar. Tiles are a compact stat strip with no tinted icon tiles | `after/dashboard-desktop.png` |
| #9 Empty location card | Rank card sizes to its content beside the trend, and is hidden when the scope has one group | `after/dashboard-desktop.png` |
| #10 Group views repeat | Share donut removed. The group table has a visible "By <group>" heading and count | `after/dashboard-desktop.png` |
| #11 Open off-screen on phone (High) | Needs-attention rows are phone cards: name + status, details, recruiter, waiting, and a 40px Open button | `after/dashboard-mobile.png` (Open at x 277–363) |
| #12 Small "View all" | 28px target on desktop, 40px on phones | — |
| #13 Age bar | Removed. "Waiting" is a right-aligned number | — |

**Validation (wave 2):** typecheck is clean and the `src/dashboard`, `src/performance` and `src/employees` unit tests pass (65). The shared API on :3000 was down during this wave: nothing was listening there or on the database port, and there was no Docker daemon. So the screens were checked in Playwright against this branch's Vite build, with fictional fixtures served by `page.route`. The fixture shapes come from the typed clients and the CEO capabilities from the shared catalog. Viewports were 1440×900 and 390×844, light and dark. Page width at 390 is 390 in every shot, and row actions sit inside the viewport at 1440. Re-check against the seeded API when it is back.

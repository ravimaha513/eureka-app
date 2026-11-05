# Performance — `/performance`
Status: Audited · Redesign proposed
Who / permission: `performance:read` (nav.ts:35) — recruiters (own), leads, managers, AD, CEO; `performance.target:manage` sets targets
Source: `apps/web/src/performance/PerformancePage.tsx`
Evidence: `performance-desktop-full.png`, `performance-mobile.png`, `performance-mobile-full.png`, `performance-drill-desktop.png` (new), `performance-drill-desktop-full.png` (new)

## Primary objective
Compare people's submissions → interviews → placements and ratios over a period, drill into the rows behind a number, and check targets.

## What's on screen
From/Through date inputs. 8 tiles (5 counts with "Show rows", 3 ratios). Person table with 10 columns (Person, Team, 5 counts, 3 ratios). A drill-down table that appears below it on click (6 cols, paged). Active candidates table (5 cols). Targets table (6 cols + actions). "Teams and designations" table for managers.

## Problems
| # | Problem (evidence) | Category | Severity |
|---|---|---|---|
| 1 | Clicking "Show rows" or a count opens the drill table **below** the person table (PerformancePage.tsx:150), with no scroll and no focus move (`openDrill` L70-73). From the tiles, nothing visible happens: the result is ~600px down (`performance-drill-desktop.png`, viewport unchanged). | Efficiency / A11y | High |
| 2 | Count columns aren't numeric-aligned. No `className="num"` on th/td (L119-131), and drillable counts are `btn sm ghost` with padding, so "12" sits ~14px to the right of "0" in the same column (`performance-desktop-full.png`, Submissions col). | Visual | Medium |
| 3 | The person table needs horizontal scroll at 1440: "Placement ra…" is clipped (`performance-desktop-full.png`). The ratio headers ("Submission → interview") are long, while the Person cell wraps designation onto 2-3 lines ("Senior / Recruiter"). | Responsive / Visual | Medium |
| 4 | 6 of 10 rows are all-zero leads/managers listed first (alphabetical); the producers (r1a…r3a) are at the bottom. No sorting and no "hide zero rows". | Efficiency | Medium |
| 5 | Ratios aren't defined anywhere on screen ("Placement ratio 16.7%" = placements/submissions?). Ratio tiles share the count-tile style but have no action, so tile heights are uneven (`performance-desktop-full.png`, row 2). | Cognitive | Medium |
| 6 | Period control differs from the Dashboard (segmented 7/30/90 days) and Reports (90-day default): here it's two native date inputs, default 30 days, no presets. | Consistency | Medium |
| 7 | Drill table: Status is a raw enum with underscores replaced, lower-case ("interview completed", L171), unlike the `pipelineLabel()` used on Dashboard. The Recruiter column repeats "r1a Team Rohit" on every row when drilled to r1a. | Visual | Low |
| 8 | "Active candidates on end-client projects" lists Cand1 with "Ended Nov 4, 2026" (`performance-desktop-full.png`). Calling someone who ended "active" is contradictory unless it's explained ("active at any time in the period"). | Cognitive | Low |
| 9 | Empty Targets table takes ~200px with full headers (`performance-desktop-full.png`). | Visual | Low |
| 10 | Mobile: the 10-col person table scrolls sideways with Person not sticky, so after scrolling you lose who the row is (`performance-mobile.png`). | Responsive | Medium |

## Recommended redesign
### Desktop
- Put the period on the shared segmented control (7/30/90 + Custom → date inputs), the same as Dashboard.
- Tiles: 5 count tiles. Ratios go in one "Conversion" tile with 3 lines and a definition tooltip/caption ("Submission→interview = interviews ÷ submissions").
- Person table: `num` alignment; counts as links styled as text (underline on hover), not ghost buttons. Sticky first column. Sortable headers (client-side; data is in memory). "Hide people with no activity" toggle, on by default. Ratio headers shortened to "Sub→Int", "Int→Plc", "Plc %" with `<abbr title>`.
- Drill-down opens in a side drawer (reuse the `TeamDrawer`/courses drawer Dialog pattern) with focus moved to its heading, or scroll + focus the inline section.
- Collapse the Targets empty state to one line plus the "Set target" button.
### Mobile
Person table → card per person (name, team, 5 counts in a row, ratios in a muted line). Tiles 2-up.
### Reusable components
Existing: `Dialog` drawer variant, `.tiles`, `th.num`. New: `<PeriodPicker>` shared with Dashboard/Reports; `<SortableTh>`.

## Before/after interaction comparison
| Task | Before | After |
|---|---|---|
| See r1a's submissions | Click 12 → scroll down to find table | Click 12 → drawer opens with focus |
| Compare top recruiters | Scroll past 6 zero rows, scan unaligned numbers | Default hides zeros; click header to sort |
| Look at last 7 days | Edit From date with picker | 1 click on "7 days" |

## Expected benefit
Drill-down becomes discoverable, rows are scannable, period handling is the same across the three analytics screens.

## Implementation complexity: M
PerformancePage.tsx only, plus a shared PeriodPicker (small). No API change.

## Scorecard
| Dimension | Score | Evidence |
|---|---|---|
| Usability | 5 | Drill result is off-screen (#1) |
| Visual hierarchy | 6 | Clean sections; zero rows dominate (#4) |
| Efficiency | 5 | No sort/presets (#4, #6) |
| Responsiveness | 5 | Non-sticky wide table on mobile (#10) |
| Accessibility | 6 | Good labels/aria; no focus move to drill (#1) |
| Design consistency | 5 | Period, status labels, ratio tiles (#5-#7) |

## Validation
Visual inspection: CEO at 1440 and 390, drill-down opened. No page-level horizontal overflow at 390 (measured). Redesign validation: pending (not implemented).

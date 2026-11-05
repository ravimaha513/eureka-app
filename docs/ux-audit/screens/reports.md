# Reports — `/reports`
Status: Audited · Redesign proposed
Who / permission: `report:read` or `report.market:read` (nav.ts:36). Market tab needs `report.market:read`; Export needs `report:export`
Source: `apps/web/src/employees/JoiningsExitsReport.tsx` (ReportsPage + JoiningsExitsPanel), `employees/ActiveEmployeesReport.tsx`, `employees/MarketReport.tsx`
Evidence: `reports-desktop-full.png`, `reports-mobile.png`, `reports-mobile-full.png`, `reports-market-desktop-full.png` (new)

## Primary objective
Ops/CEO count joinings and exits (and active headcount, market supply) for a period, and export CSV.

## What's on screen
Tabs (Joinings and exits / Market). Joinings tab: intro, From/Through, Export CSV + hint. h2 + 7 tiles (Joinings, First assignments, Exits, 4 "Exits: <reason>"). By-team table (3 cols), by-payroll-company table (4 cols), events table (9 cols). Then a second report, "Active employees", with its own Month + Client filters, 1 tile and 2 tables. Market tab: Group by, Placed from/through, Export, 3 tiles, a 13+ column table.

## Problems
| # | Problem (evidence) | Category | Severity |
|---|---|---|---|
| 1 | Three tables are stacked with no visible headings or gap: by team, by payroll company, events (JoiningsExitsReport.tsx:130-179 use only `aria-label`). In `reports-desktop-full.png` they touch, so the header rows look like data rows of one table. Same for the two Active-employees tables. | Hierarchy | High |
| 2 | Vertical rhythm is broken. The intro `p.sub` sits on the "From" label, the h2 sits on the date inputs, and "Active employees" sits on its table (`reports-desktop-full.png` y≈210-300, 1040-1100). | Visual | Medium |
| 3 | Tile redundancy. "Joinings 2 / 2 first placements" and "First assignments 2 / 0 later assignments" repeat each other. Four "Exits: <reason>" tiles (L125-127), three of them 0, make the row wrap to a lonely 7th tile. | Efficiency / Visual | Medium |
| 4 | Two independent filter sets on one tab (period for Joinings, Month+Client for Active employees, L184) with nothing to say which one controls what. | Cognitive | Medium |
| 5 | Wide tables are clipped at 1440 (and on mobile even the 3-col By-team table hides "Exits" off-screen, `reports-mobile.png`): events "End rea…/Compl…" (`reports-desktop-full.png`), Market "Be…" with 13+ cols (`reports-market-desktop-full.png`). Numbers aren't `num`-aligned (L136, L149-150). | Visual / Responsive | Medium |
| 6 | Tabs have `role="tab"` but no arrow-key handling and no roving tabindex (L38-43). AccessPage implements both (AccessPage.tsx:35-44), so tab behaviour is inconsistent across screens. | A11y | Medium |
| 7 | Default periods differ across insight screens: Reports 90 days (L59), Performance 30, Dashboard 7. Market's date inputs are empty (`mm/dd/yyyy`) and its "Group by" label sits inline while the other labels are stacked (`reports-market-desktop-full.png`). | Consistency | Low |
| 8 | Candidate cell repeats "Assignment 1" under every name (L167) and wraps to 3 lines. | Visual | Low |

## Recommended redesign
### Desktop
- Each table gets a visible `h3` ("By team", "By payroll company", "Events") and 16-24px spacing. Put the two small summaries side by side (2-col grid) above the events table.
- Tiles: Joinings (hint "2 first placements · 0 later"), Exits (hint listing the non-zero reasons: "1 completed"). Drop the separate First-assignments and per-reason tiles, or show reasons as a small stacked bar in the Exits tile.
- Split "Active employees" into its own tab ("Joinings and exits | Active employees | Market") so each tab has one filter set.
- Shared PeriodPicker (presets + custom). `num` alignment; sticky first column on wide tables; "Assignment N" only when N>1.
- Tabs: reuse the AccessPage keyboard handler (extract `useTablist`).
### Mobile
Tables → card rows (event badge + date, candidate, client · team). The filter row stacks; Export goes full-width.
### Reusable components
Existing: `.tiles`, `.tabs`. New: `useTablist()` hook (from AccessPage.tsx:35-44), `<PeriodPicker>`, `<SectionTable title>` wrapper.

## Before/after interaction comparison
| Task | Before | After |
|---|---|---|
| Find exits by team | Work out which of 3 headerless tables is which | Read the "By team" heading |
| Check active headcount for Dec | Scroll past whole joinings report, set Month | Click "Active employees" tab, set Month |
| Keyboard switch tabs | Tab to each tab | Arrow keys |

## Expected benefit
The sections become readable and the tiles stop repeating. One filter per tab makes clear what each filter controls.

## Implementation complexity: S–M
JoiningsExitsReport.tsx, ActiveEmployeesReport.tsx (mount point), styles spacing. No API change.

## Scorecard
| Dimension | Score | Evidence |
|---|---|---|
| Usability | 6 | Works; sections ambiguous (#1, #4) |
| Visual hierarchy | 4 | Unlabelled stacked tables, cramped spacing (#1, #2) |
| Efficiency | 6 | Redundant tiles (#3) |
| Responsiveness | 5 | Wide tables scroll; Market 13+ cols |
| Accessibility | 6 | Tabs without keyboard model (#6); tables have aria-labels |
| Design consistency | 5 | Periods/tabs differ from siblings (#6, #7) |

## Validation
Visual inspection: CEO at 1440 (both tabs) and 390. No page-level overflow at 390 (measured). Redesign validation: pending (not implemented).

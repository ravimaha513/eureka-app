# Interview reports — `/interview-reports`
Status: Audited · Redesign proposed
Who / permission: `report:read` AND `interview:read` (nav.ts:38): leads, managers, CEO, interview leads. Export needs `report:export`.
Source: `apps/web/src/interviews/InterviewReportsPage.tsx`, `interviews/InterviewsPage.tsx` (`CandidateFeedbackCell`, `dateBoundary`)
Evidence: `interview-reports-desktop.png`, `interview-reports-desktop-full.png`, `interview-reports-mobile.png`, `interview-reports-mobile-full.png`, new: `interview-reports-daily-{desktop,mobile}.png`

## Primary objective
Review interview volume, clearance rate and duration by coach, technology, candidate or duration bucket over a period. Review one day's interviews with candidate feedback, and export both.

## What's on screen
- Tabs: Summary | Daily interviews.
- Summary: H2, From / Through / Group by, Export CSV + cap hint; 3 KPI tiles (Interviews, Cleared, Total duration); 6-column table; footnote.
- Daily: Day + Previous/Next day + Export; one-line totals; 7-column table with candidate feedback.

## Problems
| # | Problem (evidence) | Category | Severity |
|---|---|---|---|
| 1 | Report rows are not drillable. A coach, technology or candidate row can't be opened to see its interviews, and Daily rows don't open `/interviews/<id>` even though `id` is in the payload (`InterviewReportsPage.tsx:102-105, 153-161`). Every follow-up means re-filtering the Interviews board by hand. | Efficiency | High |
| 2 | State isn't in the URL: tab, period, group-by and day are all `useState` (`:54-56, 120, 174`). A report can't be bookmarked or shared, and Back resets to Summary/30 days. | Efficiency | Medium |
| 3 | Tabs: `role="tab"` without `id`/`aria-controls`, arrow-key handling or roving tabindex, and the `tabpanel` has no label (`:182-186`). This partly fails the ARIA tabs pattern (keyboard users can still Tab to them). | A11y | Medium |
| 4 | The tiles mix "Cleared" (the readiness flag) with interview outcome. The tile says "40% of interviews" and the footnote says cancelled interviews are excluded, but nothing says that "Cleared" here means pre-call readiness rather than the round result (`InterviewsPage.tsx:38` comment). Users will read it as a pass rate. | Cognitive | Medium |
| 5 | Layout: the H2 sits on top of filter labels with no spacing, and tiles touch the filter row and the table (`interview-reports-desktop.png`). The "coach" group label is a raw username, and "Unassigned" dominates (15 of 20), which makes the coach grouping weak. That's data, but there's no sort, so the user can't rank coaches. | Visual | Low |
| 6 | Mobile: Previous day and Next day wrap onto separate rows, and Export is on a third row (`interview-reports-daily-mobile.png`). The Summary table is 652px in 360px (measured). | Responsive | Medium |
| 7 | Daily time shows browser-local only, with no zone label (`:154`). The Interviews board has a display-zone selector this page ignores. | Consistency | Low |
| 8 | "Total duration 20 h 0 min". The "0 min" adds noise (`hours()`, `:40`). | Visual | Low |

## Recommended redesign
### Desktop
- Rows are clickable. A group row opens `/interviews?from=…&to=…&<groupKey>=…` once the board's filters are URL-backed (see interviews.md #9); coach/candidate filters exist on the board API, but technology may not (verify). A daily row links to `/interviews/<id>`.
- URL params `?tab=daily&day=…&from=…&to=…&groupBy=…`.
- Proper tabs (shared `Tabs` component). Rename the tile and column to "Ready (cleared for call)", and add a "Result: cleared" column if the API exposes it (else leave it).
- Sortable numeric columns. Period presets: 7 / 30 / 90 days.
- Spacing: 16px between toolbar, tiles and table. Format durations as "20 h".

### Mobile
Previous / day / Next as one segmented control row. Export in a header overflow. Daily rows as cards (time, candidate, client · round, status, feedback stars).

### Reusable components
Existing: `QueryError`, `Loading`, `CandidateFeedbackCell`, `Stars`, tiles CSS. New shared: `Tabs`, `DateStepper` (prev/day/next), `ResponsiveTable`, sortable header helper.

## Before/after interaction comparison
| Task | Before | After |
|---|---|---|
| See which interviews a coach cleared | Note name, go to Interviews, filter coach (not available as filter), date range = 5+ | Click coach row = 1 |
| Open an interview from Daily | Go to Interviews, search candidate, Details = 3+ | Click row = 1 |
| Share last week's report | Describe filters in chat | Copy URL |

## Expected benefit
The report becomes a starting point for coaching follow-ups rather than a dead end. Readiness won't be mistaken for pass rate. Keyboard tabs work properly.

## Implementation complexity: S–M
`InterviewReportsPage.tsx`, small CSS. Drill-down depends on Interviews board URL filters (same project). A coach filter on the board would need an API param if it doesn't exist (verify). Otherwise no API change.

## Scorecard
| Dimension | Score | Evidence |
|---|---|---|
| Usability | 6 | Simple, clear exports; "Cleared" ambiguity (#4) |
| Visual hierarchy | 6 | Tiles clear; cramped spacing (#5) |
| Efficiency | 5 | No drill-down, no URL state (#1, #2) |
| Responsiveness | 5 | Wrapping toolbar, 652px table at 390 (#6) |
| Accessibility | 6 | Labelled filters/tables; tabs pattern incomplete (#3) |
| Design consistency | 7 | Matches report pattern; zone ignored (#7) |

## Validation
Visual inspection: Summary desktop + mobile (existing), Daily tab desktop + mobile (new; today had 0 interviews so the empty state was captured). Table widths measured. Redesign validation: pending (not implemented).

# Interviews — `/interviews` (record: `/interviews/<id>`)
Status: Audited · Redesign proposed
Who / permission: `interview:read` (nav.ts:18): recruiters, leads, managers, CEO, location ops, interview coaches. "Schedule interview" needs `interview:create`. "Clear and place" needs `placement:create`. Per-row editability comes from server `editableFields`.
Source: `apps/web/src/interviews/InterviewsPage.tsx` (board, `Schedule`, `Edit`, `Feedback`, `InterviewDrawer`), `calendar/SupportCalendar.tsx`, `pipeline/CreatePlacementDialog.tsx`; routing `App.tsx:474`
Evidence: `interviews-desktop.png`, `interviews-desktop-full.png`, `interviews-mobile.png`, `interviews-mobile-full.png`, new: `interviews-detail-{desktop,mobile}.png`, `interviews-detail-full-{desktop,mobile}.png`, `interviews-detail-url-{desktop,mobile}.png`, `interviews-create-dialog-{desktop,mobile}.png`, `interviews-edit-dialog-{desktop,mobile}.png`

**How a record opens:** each row's **Details** button (`InterviewsPage.tsx:405`) calls `showDetails` → `onOpenChange` → URL `/interviews/<id>`. Deep links work too: `/interviews/27de…` opens the drawer from `initial` (`:373-381`, `interviews-detail-url-desktop.png`). The earlier script probably missed it because the board defaults to "today onward" and Details sits in the clipped actions column (see #1).

## Primary objective
See upcoming and past interviews, keep each one ready (invite, consent, coach), record the result and feedback, and turn a cleared round into a placement.

## What's on screen
- Header + "Schedule interview" primary.
- Filter toolbar: Display timezone, Candidate, Batch, From date (defaults to today), Through date, Call status, Clearance, Result, Location, + Today and Reset filters buttons. 11 controls, 2 rows at 1440, 7 rows at 390.
- Optional Support calendar card (`calendar:block`).
- Table: 8 columns (Candidate/client, Time/round, Team/location, Readiness, Result, Candidate feedback, Recordings, Actions). Each row stacks 4 full-size buttons (Details, Edit interview, Feedback, Clear and place). "Load more" infinite paging.
- Drawer "Interview details": person header, info grid (11 facts), .ics button, support calendar block, Reviewers cards. **No actions, no links.**
- Dialogs: Create interview (13 controls), Edit interview (up to 15 fields + panel picker), Feedback (list + add form), Create placement.

## Problems
| # | Problem (evidence) | Category | Severity |
|---|---|---|---|
| 1 | The actions column is clipped at 1440px: the table is 1161px in a 1110px card ("Edit intervie", "Clear and pla" cut off; `interviews-desktop.png`). Each row stacks 4 full-height 38px `.btn` buttons (`InterviewsPage.tsx:405` uses `btn`, not `btn sm`), so rows are ~195px tall. Only about 2.5 interviews fit per screen, which is very low density for a daily board. | Efficiency / Visual | High |
| 2 | The board doesn't link to related records. The candidate name is plain `<b>` (`:398`), and the client link filters the board instead of opening anything. The drawer has no link to the submission, candidate or placement, even though `submissionId` and `placement.id` are in the payload (`:29,40`). The "Placement: confirmed" text in the Result column (`:402`) is not a link. | Efficiency | High |
| 3 | The detail drawer is read-only. To edit, add feedback or clear a round from it, the user must close it and find the row again. Edit, Feedback and Clear and place exist only as row buttons (`:282-332`, `interviews-detail-desktop.png`). | Efficiency | High |
| 4 | Time display: start and end each show the full date with seconds ("11/6/2026, 2:00:00 PM to 11/6/2026, 3:00:00 PM"; `:399`, `interviews-desktop.png`). That's 4 lines for one slot. The drawer uses a different format ("Nov 6, 2026, 2:00 PM", `:286`) and omits the end time and time zone. | Visual / Consistency | Medium |
| 5 | The time-zone model is confusing. Display zone is selectable (local or New York only), but "Date filters and scheduling use UTC" (`:383`). Create interview says "Enter the slot in UTC" in small hint text above the field (`:179`). The Edit dialog uses `datetime-local` in the browser zone, not the selected display zone (`:227`). A user who chose New York for display still schedules in local time. | Cognitive | High |
| 6 | Create interview orders fields poorly. Interview type comes before choosing the submission, and Position/Candidate name are read-only echo inputs (`:167-176`, `interviews-create-dialog-desktop.png`). The submission picker is a search box plus a native `<select>` with "Load more submissions" (100 per page). It is a different form from the submission drawer's scheduler (SlotPicker; see submissions #6). | Cognitive / Consistency | Medium |
| 7 | The Edit dialog renders a broken checkbox. "Invite received" appears as a 40px empty square above its label (`interviews-edit-dialog-desktop.png`). Cause: boolean fields are wrapped in `.field` (`:238`), so `.field input {height:40px; min-width:200px}` (`styles.css:204`) and `.dialog .field input {width:100%}` (`styles.css:319`) style the checkbox. The same happens for Cleared and Consent captured. Autofocus lands on the read-only Position input, which shows a focus ring as if it were editable. | Visual / A11y | Medium |
| 8 | Status words are lowercase raw enums ("scheduled", "no invite") in the table, drawer badge and Call status select (`label()` at `:18` vs `pipelineLabel` used on Submissions). The drawer badge colour borrows submission classes (`:292`). | Consistency | Low |
| 9 | Filters live in component state, not the URL (`:341`), unlike Submissions and Placements (`useSearchParam`). Refresh or back-navigation from a candidate loses the board view. "Reset filters" also clears From, so it shows all history rather than returning to the default "today onward" (`:390`). | Efficiency | Medium |
| 10 | Readiness and Recordings take 2 columns of mostly negative text ("Not cleared / Awaiting invite / Consent pending", "Consent required"), which is hard to scan. There are no icons or counts, and the row tint `row-cleared` is the only visual signal. | Hierarchy | Medium |
| 11 | Mobile: the table is 1161px in 360px. At 390px the first row starts at ~780px (`interviews-mobile.png`), and Actions sit 800px to the right. The client "View history" link-buttons are 17px tall, below the WCAG 2.2 24px target (measured; `:398`). | Responsive / A11y | High |
| 12 | Feedback form: errors come from a thrown `Error` in `useSubmit` (`:264`), with no field-level association. Scorecard selects are 4 extra selects. The "Close" button only exists when there's no form (`:277`). | A11y | Low |

## Recommended redesign
### Desktop
- **Agenda density.** Group rows by day (sticky day header "Fri, Nov 6"). Collapse time to "2:00–3:00 PM" plus the zone abbreviation in the header. Columns: Time | Candidate (link) · client · round · type | Coach/Team | Readiness icons (invite ✓, consent ✓, cleared ✓, with text in sr-only/title) | Result badge | one primary action + "⋯" menu (Edit, Feedback, Clear and place). Target a row height of 56–64px. This also fixes the clipping.
- **Actionable drawer.** Header shows candidate (link to `/candidates/<id>`), "Submission" link (open `/submissions/<submissionId>` once routed), placement link when `placement`. Footer actions: Edit, Add feedback, Mark cleared / Clear and place. Add the end time and zone to "Interview slot".
- **One time-zone control** at page level. It drives display, filters and the slot inputs of Create/Edit. Show the zone inside the slot label ("Start (America/New_York)"). Add Chicago and Los Angeles options.
- **Create interview:** Submission first (single combobox with type-ahead; the async search already exists), then Round (datalist), then the shared SlotPicker, then Type/Link/Panel/Coach. Drop the read-only echo inputs. Show "Cand9 Test · Java Microservices Engineer" as text under the combobox.
- Fix the checkbox: render boolean fields with `label.check` (as `Schedule` does at `:187`), not `.field`. Autofocus the first editable field.
- Put filters in the URL (`useSearchParam`). "Reset" returns to the default (today onward). Use `pipelineLabel` for statuses.

### Mobile
- Card list per interview: time + zone, candidate, client · round, readiness icons, primary action. "⋯" for the rest. Filters in a sheet with only Candidate and the date range visible.
- Client history link-button: min-height 24px (padding) or make the whole client line the target.

### Reusable components
- Existing: `Drawer`, `SlotPicker`, `CreatePlacementDialog`, `pipelineLabel`, `useSearchParam`, `useRoutedId`.
- New shared: `ResponsiveTable`/card list, `RowMenu` (overflow menu for secondary row actions; also Submissions), `RecordLink`, `ZoneSelect` (shared with Submissions scheduler), single `ScheduleInterviewForm`.

## Before/after interaction comparison
| Task | Before | After |
|---|---|---|
| Open an interview and add feedback | Details, read, close, find row, Feedback = 4 + scrolling | Details, Add feedback = 2 |
| Go from interview to its submission | Not possible; go to Submissions, search, Open = 4+ | Drawer "Submission" link = 2 |
| Scan today's 10 interviews at 1440 | ~4 screens of scrolling (195px rows) | 1 screen (~60px rows) |
| Schedule at 10am New York as a UTC user | Mental conversion, type in datetime-local | Zone select (remembered) + slot picker |
| Return to filtered board after viewing candidate | Filters lost, re-enter = 3–6 | Back = 1 |

## Expected benefit
A board that is about 3× denser for daily coordination. No hidden actions at laptop widths. One mental model for time zones, which removes a real mis-scheduling risk. Fewer round trips between drawer and rows. Interviews become connected to the rest of the pipeline.

## Implementation complexity: M–L
Web only, no API changes (`submissionId`, `placement.id` and `candidate.id` are already returned). `InterviewsPage.tsx` is a 417-line file with very long single-line JSX. Splitting it (Board, Drawer, dialogs) is part of the work. Also `styles.css` (hot), plus `ScheduleInterviewDialog.tsx`/`SlotPicker.tsx` for the shared form.

## Scorecard
| Dimension | Score | Evidence |
|---|---|---|
| Usability | 5 | All tasks possible but drawer read-only, time-zone ambiguity (#3, #5) |
| Visual hierarchy | 4 | 195px rows, stacked buttons, negative-text readiness (#1, #10) |
| Efficiency | 4 | Clipped actions, no links, no URL filters (#1, #2, #9) |
| Responsiveness | 3 | 1161px table at 390; first row below fold (#11) |
| Accessibility | 5 | 17px targets (AA fail), broken checkbox styling, thrown-error forms; tables and labels otherwise OK (#7, #11, #12) |
| Design consistency | 4 | Different scheduler, date formats, lowercase enums, own `Field` component (#4, #6, #8) |

## Validation
Visual inspection: desktop 1440 and mobile 390 board, detail drawer via row button and via direct URL, Create and Edit dialogs; table width and target sizes measured with Playwright. No data mutated. Redesign validation: pending (not implemented).

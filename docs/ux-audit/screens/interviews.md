# Interviews — `/interviews` (record: `/interviews/<id>`)
Status: Audited · Redesign proposed · Implemented (rebrand wave 2)
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

### Implemented (wave 2)
| Audit item | Change | Evidence |
|---|---|---|
| #1 clipped actions, 195px rows (High) | Agenda `dtable` grouped by day (sticky day head with count), time as `2:00 – 3:00 PM` with the zone in the column head, one-line readiness; one row action (Clear and place / Create placement when allowed, else Details) + ⋯ menu (Details, Edit interview, Feedback); feedback column `p3` with stars under the result below 1600px | `after/interviews-desktop.png` (rows ~54px, actions 1230-1411) |
| #2 no cross-links (High) | Candidate name → profile; placement in Result → placement; drawer links candidate, submission (needs `onOpenSubmission`, app_requests) and placement | `interviews-drawer-desktop.png` |
| #3 read-only drawer (High) | Drawer action strip: call status + result chips + slot, then Clear and place / Edit interview / Feedback; the dialogs open over the drawer (it suspends) | InterviewsPage.test (drawer actions) |
| #4 time display (Medium) | One format everywhere (`zones.ts`): `Fri, Nov 6, 2026` + `2:00 – 3:00 PM CST`; drawer shows start, end and zone | — |
| #5 time-zone model (High) | One page-level Time zone select drives display, the date filters and the Create/Edit slot inputs (Edit shows `Times in <zone>` and converts with it); options: your zone, US Eastern/Central/Pacific, India | `interviews-desktop.png` |
| #6 create form order and echo inputs (Medium) | Shared form: submission first, the chosen submission as text (no read-only echo fields), round, slot, type, link, coach, panel; Reset form kept | `interviews-schedule-dialog-desktop.png` |
| #7 broken checkbox, focus on read-only (Medium) | Booleans render as `label.check` in one group; autofocus on the first editable field; no read-only inputs | InterviewsPage.test (edit) |
| #8 raw lowercase statuses (Low) | `callStatusLabel` / `CallStatus` chip with its own quiet tints (`.badge.cs-*`), feedback kinds via labels | — |
| #9 filters not in URL; Reset clears From (Medium) | All filters + candidate in the URL; `?from=any` for every date; Clear filters returns to today onward | InterviewsPage.test |
| #10 readiness hard to scan (Medium) | `Ready` chip or `Not cleared`, then ✓/– Invite and Consent with full words for screen readers | — |
| #11 phone + 17px client link (High) | Rows become cards (time, round, readiness, result, action); client history link 24px (32px on phones); filters in the sheet | `interviews-mobile.png` |
| #12 feedback errors (Low) | Kept the dialog error (form-level); Close button now a proper footer; unsaved-change guard on Feedback and Edit | — |

**Validation (wave 2):** `pnpm --filter @eureka/web typecheck` clean; `vitest run src/pipeline src/interviews src/pipelinereport` 103/103 (tests updated only where markup intentionally changed: status selects instead of chip groups, row menus, the shared scheduling form, `More filters` disclosure). The shared API on :3000 was down during this wave (no Postgres or Docker in the session), so the after-shots were taken against the branch's Vite build with Playwright route fixtures shaped like the API (fictional data, read-only). Checked at 1440x900 and 390x844 in light and dark: `document.documentElement.scrollWidth` = 390 on phones, row actions inside the viewport at 1440 (`td.c-act` right edge 1411). E2E specs not run (they create records and need the live API).
After: `../screenshots/after/interviews-{desktop,mobile}.png`, `interviews-drawer-{desktop,mobile}.png`, `interviews-schedule-dialog-{desktop,mobile}.png`, `interviews-dark-{desktop,mobile}.png`

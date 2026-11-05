# Submissions — `/submissions`
Status: Audited · Redesign proposed
Who / permission: `submission:read` (nav.ts:17): recruiters, leads, managers, CEO. Row/drawer actions are gated by server `actions` (transition, createInterview, createPlacement, clearAndPlace, editDetails, editRate).
Source: `apps/web/src/pipeline/SubmissionsPage.tsx`, `EditSubmissionDialog.tsx`, `SubmissionRounds.tsx`, `ScheduleInterviewDialog.tsx`, `SlotPicker.tsx`, `CreatePlacementDialog.tsx`, `pipeline/ui.tsx`, `pipelineApi.ts`, `pipelinereport/AssessmentsSection.tsx`; routing `App.tsx:472`
Evidence: `submissions-desktop.png`, `submissions-desktop-full.png`, `submissions-mobile.png`, `submissions-mobile-full.png`, new: `submissions-drawer-{desktop,mobile}.png`, `submissions-drawer-bottom-desktop.png`, `submissions-schedule-dialog-{desktop,mobile}.png`, `submissions-schedule-errors-{desktop,mobile}.png`, `submissions-edit-dialog-desktop.png`, `submissions-reject-dialog-desktop.png`, `submissions-placement-dialog-{desktop,mobile}.png`, `submissions-focus-desktop.png`

## Primary objective
Find a submission and move it forward: change its status, schedule the next interview round, record round results, and convert a selected submission into a placement.

## What's on screen
- Header + 2-line description.
- Filters: 9 status chips + "All" (wrap to 2 rows at 1440, 5 rows at 390), 2 date inputs, Candidate search, Batch select, "Job or client" search, "Interview" (reached) select, conditional "Clear filters". 15 controls before data.
- Funnel: 8 clickable tiles (Submitted → Got an interview → Screening → L1 → L2 → L3+ → Final → Placed) + "Plus N other rounds · Show them".
- Table: 7–8 columns (Candidate, Job/client, Status, Interview rounds trail, Submitted, Recruiter, Rate, actions) with 1–3 row buttons (Open, Schedule interview / Schedule next round, Create placement). Cursor pager, 50/page.
- Drawer (440px, not URL-addressable): Details `dl` (10 facts) + Edit details; Interview rounds timeline with Mark cleared / Mark rejected… / Clear and place; Next steps (Move to X, Reject…, Withdraw…, Create placement); Assessments.
- Dialogs: Edit details (6 fields), Reject (reason), Withdraw (confirm), Schedule interview (Round, Day chips + date, Start time select of 68 options, Duration chips, Coach, Invite received), Create placement (6 fields, re-confirmed checkbox, up to 10 contact rows).

## Problems
| # | Problem (evidence) | Category | Severity |
|---|---|---|---|
| 1 | The table is 1298px wide inside a 1110px card at a 1440px viewport, so the actions column is clipped to "Ope" with no visible scroll cue (measured `.tablewrap` 1298/1110; `submissions-desktop.png`). The primary row action can't be seen without scrolling sideways. At 390px only Candidate and Job are visible. Status and all actions are 940px to the right (`submissions-mobile-full.png`). | Responsive / Efficiency | High |
| 2 | Status changes sit in two disconnected places. "Next steps" offers `Move to Interview scheduled` beside the separate `Schedule interview` button in "Interview rounds" (`SubmissionsPage.tsx:269-277`, `SubmissionRounds.tsx:214-219`; `submissions-drawer-desktop.png`). The UI never says whether scheduling an interview moves the status, so recruiters can end up with a status that doesn't match the rounds. The ladder is also linear: the user must click "Move to Under review", then "Move to Interview requested" and so on, one at a time. | Cognitive | High |
| 3 | There are no links between related records. The candidate name is plain `<b>` (`SubmissionsPage.tsx:152`, drawer `:239`). Rounds in the drawer don't open the interview (`SubmissionRounds.tsx:175-202`). A "Placed · Confirmed" trail chip doesn't open the placement (`ui.tsx:153`). A placement created from a row action gives a notice but no link (`CreatePlacementDialog.tsx:312-314`); only the drawer path offers "Open the new placement" (`SubmissionsPage.tsx:256`). | Efficiency | High |
| 4 | The drawer isn't in the URL (`useState` openId, `SubmissionsPage.tsx:56`). Placements and Interviews do route `/key/<id>` (`App.tsx:473-474`). A submission can't be shared, reopened after refresh, or linked to from Interviews and Placements. | Efficiency | Medium |
| 5 | Schedule interview: the time zone appears only after both day and time are picked ("Pick a day and a start time." until then; `SlotPicker.tsx:98-101`, `submissions-schedule-dialog-desktop.png`). There's no way to enter the time in the client's or candidate's zone, even though the Interviews board offers America/New_York (`InterviewsPage.tsx:384`). Day chips cover 5 calendar days including weekends (Sat 7, Sun 8), so next Tue/Wed need the date picker. Round has no default for a first round (empty and required) and no suggestions, while the board's dialog has a datalist (`InterviewsPage.tsx:107-111`). | Efficiency / Cognitive | High |
| 6 | There are two different "Schedule interview" forms for the same API. This one has a SlotPicker, no type, meeting link or panel. The board's "Create interview" has native `datetime-local`, type, panel, lead and link (`ScheduleInterviewDialog.tsx:398-411` vs `InterviewsPage.tsx:149-191`). An interview scheduled from a submission can't get a meeting link or type until someone edits it on the board. | Consistency | Medium |
| 7 | Status filter chips have no counts (`SubmissionsPage.tsx:94` passes no `counts`), even though `StatusChips` supports them (`ui.tsx:27-46`). The funnel above shows counts for a different dimension, so two rows of "status-like" pills compete. The funnel's base is also misleading: "Placed 29% of L1" while L2/L3/Final are 0 (`ui.tsx:105`, `submissions-desktop.png`). | Hierarchy / Cognitive | Medium |
| 8 | 15 filter controls and the funnel push the first data row below the fold on mobile. Rows start at ~1150px of 844 (`submissions-mobile.png`), and at 1440 the table starts at y≈617. Filters can't be collapsed. | Responsive | Medium |
| 9 | Candidate and Job/client searches are not in the URL (`useState`, `SubmissionsPage.tsx:38,43`), but status, date, batch and reached are. A shared link loses half the filter set. | Efficiency | Low |
| 10 | Row buttons are `.btn.sm` at 30px high (`styles.css:209`). This passes WCAG 2.2 AA (24px) but is below 44px touch size: 98 of 106 controls are under 44px at 390px. | A11y / Responsive | Low |
| 11 | "Submitted" shows a time ("Nov 3, 2026, 2:00 PM") in every row (`SubmissionsPage.tsx:156`), which widens the column. A date is enough for scanning; the time belongs in the drawer. | Visual | Low |
| 12 | The "Record assessment" button stretches to full drawer width while every other drawer action is inline sm (`submissions-drawer-desktop.png`; `AssessmentsSection.tsx:206` inside `.manageblock`). | Consistency | Low |

## Recommended redesign
### Desktop
- **Table fits 1110px.** Merge "Submitted" and "Recruiter" into one cell ("Nov 3 · r2a"). Show Rate only in the drawer or a second line. Put the actions column first after Candidate, or make the whole row clickable (`<tr>` with a candidate-name link button) and keep a single **primary next action** per row, chosen from `actions`: Schedule next round, then Create placement, then Open. Sticky actions column (`position: sticky; right: 0`) as a fallback.
- **One status control in the drawer.** Replace the "Move to …" ladder with a status `<select>`/segmented list of `actions.transition` plus a single "Update" button. Keep Reject…/Withdraw… as danger. Put it in the drawer header next to the status badge so status and rounds read together. When `Schedule interview` succeeds and status is `interview_requested`, say so in the notice ("Status is still Interview requested — move to Interview scheduled?") with a one-click action. Don't auto-change status unless the API already does.
- **Route the drawer:** `/submissions/<id>`, same `useRoutedId` pattern as `PlacementsPage.tsx:113`.
- **Links:** candidate name opens `/candidates/<id>`, each round row opens `/interviews/<id>`, the "Placed · X" chip and the drawer's placement opens `/placements/<id>`. The row "Create placement" success notice includes "Open placement".
- **Scheduling:** show "Times in UTC" next to the Start time label always. Add a time-zone select (local / America/New_York / America/Chicago / America/Los_Angeles) shared with the board's display-zone control. Make the day chips the next 5 **business days**. Add the `INTERVIEW_ROUNDS` datalist to Round and default the first round to "Screening"/"L1". Add Interview type + Meeting link (optional) so both scheduling forms reach parity, ideally a single shared `ScheduleInterviewForm`.
- Status chips get counts from the summary query. The funnel's percentages compare to the previous **non-zero stage up to the stage before** only within interview stages; "Placed" compares to "Got an interview".

### Mobile
- Under 640px, render rows as cards: name (link), job · client, status badge + trail, primary action button full width. No horizontal table.
- Collapse filters behind a "Filters (n)" button opening a sheet. Keep status chips as a single horizontally scrollable row.
- Funnel: horizontal scroll strip, 1 row.

### Reusable components
- Existing: `StatusChips` (with counts), `PipelineFunnel`, `StageTrail`, `Drawer`, `useRoutedId`, `SlotPicker`, `Pager`.
- New shared: `ResponsiveTable` (table → card list under 640px; needed by Interviews, Placements, Pipeline too), `FilterBar` (collapsible on mobile with active count), `RecordLink` (candidate/submission/interview/placement link by id), `StatusSelect` (transition picker used by submission + placement drawers), single `ScheduleInterviewForm`.

## Before/after interaction comparison
| Task | Before (steps/clicks) | After |
|---|---|---|
| Move Submitted → Interview scheduled | Open drawer, Move to Under review, Move to Interview requested, Move to Interview scheduled, close = 5 clicks | Open, pick status, Update = 3 |
| Schedule next round at 10am New York for a UTC user | Row "Schedule next round", day chip, compute UTC by hand, pick time from 68 options, Schedule = 4 + mental math | Same clicks, pick NY zone once (remembered), no conversion |
| From a submission, see its interview's meeting link | Leave page, go to Interviews, search candidate, Details = 4+ and retyping | Drawer round row click = 2 |
| Open placement created from row action | Notice only; go to Placements, search name, Open = 4 | "Open placement" in notice = 1 |
| Act on a row at 1440px | Scroll table sideways, Open = 2 | Open visible = 1 |

## Expected benefit
Fewer clicks for the most frequent recruiter action (status/round updates). Status and rounds stay consistent. Records are linked, so recruiters can move between submission, interview, placement and candidate. No hidden actions at common laptop widths. Mobile becomes usable for status checks.

## Implementation complexity: M
Web only, no API changes. Touches `SubmissionsPage.tsx`, `SubmissionRounds.tsx`, `ScheduleInterviewDialog.tsx`, `SlotPicker.tsx`, `CreatePlacementDialog.tsx`, `pipeline/ui.tsx`, `App.tsx` (route id, hot file), `styles.css` (hot file, responsive table). All ids needed for links are already in the payload: `Submission.candidateId` (`pipelineApi.ts:40`), `Interview.id`, trail `id`. Placement id from a trail chip needs `placementId` on the list row. Until that's added, link the chip to `/placements?candidate=<name>` (the filter exists).

## Scorecard
| Dimension | Score | Evidence |
|---|---|---|
| Usability | 6 | Status workflow works, with good confirmations and reasons (#2 High) |
| Visual hierarchy | 6 | Two competing pill rows; funnel well done (#7) |
| Efficiency | 4 | Clipped actions, linear ladder, no cross-links, no URL (#1, #2, #3 High) |
| Responsiveness | 3 | Status/actions 940px off-screen at 390, data below fold (#1, #8) |
| Accessibility | 7 | Good labels, aria-pressed, live regions, focus to first invalid; 30px targets; day-error not tied to a focusable invalid field (`SlotPicker.tsx:57`) |
| Design consistency | 5 | Two scheduling forms, full-width assessment button (#6, #12) |

## Validation
Visual inspection: desktop 1440 and mobile 390 list, drawer, schedule dialog (empty and error state), edit/reject/placement dialogs, keyboard tab order; overflow measured with Playwright (no page overflow; table 1298/1110 and 1298/360). No data was mutated. Redesign validation: pending (not implemented).

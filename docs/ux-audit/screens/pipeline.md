# Candidate Pipeline — `/pipeline`
Status: Audited · Redesign proposed
Who / permission: `report:read` (nav.ts:40). The API also checks `candidate:read`. Leads, managers, CEO, location ops.
Source: `apps/web/src/pipelinereport/PipelineReportPage.tsx`, `pipelinereport/AssessmentsSection.tsx` (rendered in the submission drawer, `SubmissionsPage.tsx:286`), `pipelinereport/pipelineReportApi.ts`; routing `App.tsx:493`
Evidence: `pipeline-desktop.png`, `pipeline-desktop-full.png`, `pipeline-mobile.png`, `pipeline-mobile-full.png`, `submissions-drawer-desktop.png` (Assessments section)

## Primary objective
See where every candidate in scope is (marketing → submitted → interviewing → assessments → confirmed → paperwork → joined) and find the stuck or non-responding ones.

## What's on screen
- Filters: "Limit to a period" checkbox (reveals From/Through), Technology, Location, Stage, "Not responding only" checkbox.
- "156 candidates" H2; 8 KPI tiles (7 funnel stages + Not responding), wrapping to 2 rows at 1440.
- Table: 8 columns (Candidate + tech · location, Stage, Marketing start, Submissions, Interviews, Assessments, Placement, Team/recruiter); Previous/Next offset pager.
- AssessmentsSection (submission drawer): list of assessments + Edit; "Record assessment" opens an inline 6-field form.

## Problems
| # | Problem (evidence) | Category | Severity |
|---|---|---|---|
| 1 | Candidate names are dead text. `PipelineReportPage` supports `onOpenCandidate` (`:19, 137`), but `App.tsx:493` renders `<PipelineReportPage />` without it. The only purpose of the report (find a stuck candidate, then act) ends here. Measured: 7 interactive controls on a 156-row page (`pipeline-desktop.png`). | Efficiency | High |
| 2 | Funnel tiles look like the clickable funnel on Submissions (`ui.tsx:82-127`) but are static `<li>` (`:99-105`). Users will click "Interviewed 28" and nothing happens. Filtering by stage needs the separate Stage select. | Consistency / Cognitive | Medium |
| 3 | Table cells are mostly zeros ("0 / 0 cleared", "0 / 0 passed" in most rows; `pipeline-desktop.png`). Counts aren't links to the candidate's submissions or interviews, and there's no "days in stage" or last-activity signal, which is what shows a candidate is stuck. Marketing start is shown, but nothing is sorted by it. | Hierarchy / Efficiency | Medium |
| 4 | Placement badge text is a lowercase raw enum ("joined"; `.replace("_"," ")` only replaces the first underscore, `:149`), while Stage shows "Joined". | Consistency | Low |
| 5 | Filters aren't in the URL (`useState`, `:23-30`). Leaving to open a candidate (once #1 is fixed) and coming back loses filters and page offset. | Efficiency | Medium |
| 6 | Mobile: the table is 977px in 360px (measured). At 390px only Candidate, Stage and part of Marketing start are visible, and 8 tiles take 3 rows (~270px) before the table (`pipeline-mobile.png`). | Responsive | High |
| 7 | Checkboxes are 13×13px (measured: "Limit to a period", "Not responding only"). The label makes the hit area larger (`label.check`), so it passes AA via the label, but the raw box is below 24px. "Limit to a period" sits on the baseline of the other labelled fields, so it looks misaligned (`pipeline-desktop.png`). | Visual / A11y | Low |
| 8 | AssessmentsSection: "Record assessment" is full-width while sibling drawer actions are inline (`submissions-drawer-desktop.png`). The form disables submit when the completed date is missing, but doesn't say why until the user notices `aria-invalid` (`AssessmentsSection.tsx:221, 269`). There's no error text for the missing date. Status badges reuse placement classes (`st-joined`, `st-backout`) for passed/failed (`:190`). | A11y / Consistency | Medium |
| 9 | The pager differs from the rest of the app: it's an offset "Previous 1–50 of 156 Next" in `.rowactions` instead of the shared `Pager` (`:119-125`). | Consistency | Low |

## Recommended redesign
### Desktop
- Pass `onOpenCandidate={(id) => go("candidates", id)}` in `App.tsx:493`, with the candidate name as a link-style button.
- Make the funnel tiles toggle buttons (reuse `PipelineFunnel` styling: `aria-pressed`, selected state) that set `stage`. Drop the separate Stage select or keep it in sync.
- Replace the zero-heavy columns with one "Activity" column: "1 submission · 1 interview (1 cleared) · last Oct 24", muted when all zero. Add "Days in stage" **only if the API returns a stage-entered date** (else omit). Make Marketing start sortable.
- URL-backed filters. Use the shared `Pager`. Use `STAGE_LABELS`/`pipelineLabel` for the placement badge.

### Mobile
Tiles as a single horizontal scroll strip. Candidate cards: name (link), stage badge, tech · location, activity line, recruiter.

### Reusable components
Existing: `PipelineFunnel` look and behaviour, `Pager`, `pipelineLabel`, `useSearchParam`. New shared: `ResponsiveTable`, `RecordLink`. AssessmentsSection uses an inline sm button and `Field` with error text (`sales/ui` `Field`).

## Before/after interaction comparison
| Task | Before | After |
|---|---|---|
| Open a stuck candidate's profile | Copy name, go to Candidates, search, open = 4 | Click name = 1 |
| Show only Interviewing candidates | Stage select, pick = 2 | Click tile = 1 |
| Return to the filtered report after viewing a candidate | Re-apply filters = 3–5 | Back = 1 |

## Expected benefit
The report becomes actionable instead of read-only. It behaves the same way as the Submissions funnel, and mobile users get a scannable list.

## Implementation complexity: S
`App.tsx` (one prop, hot file), `PipelineReportPage.tsx`, `AssessmentsSection.tsx`, a little CSS. No API change (unless "days in stage" is wanted).

## Scorecard
| Dimension | Score | Evidence |
|---|---|---|
| Usability | 5 | Report readable but dead-ends (#1) |
| Visual hierarchy | 6 | Clear tiles; zero-noise table (#3) |
| Efficiency | 4 | No links, static tiles, no URL state (#1, #2, #5) |
| Responsiveness | 3 | 977px table at 390, tiles 3 rows (#6) |
| Accessibility | 6 | Labelled; assessment form error not explained (#8) |
| Design consistency | 5 | Funnel lookalike, raw enum, custom pager (#2, #4, #9) |

## Validation
Visual inspection: existing desktop and mobile screenshots plus the submission drawer (Assessments). Control count, checkbox size and table width measured at 1440 and 390. Redesign validation: pending (not implemented).

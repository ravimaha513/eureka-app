# Application detail — `/applications/<id>` (drawer)
Status: Audited · Redesign proposed
Who / permission: same as Applications (nav.ts:23). Actions come from the server: `actions.transition[]`, `scheduleInterview`, `createCandidate`, per-interview `scorecard` / `setStatus`.
Source: apps/web/src/jobs/ApplicationsPage.tsx:141-432 (ApplicationDrawer, StatusDialog, ScheduleDialog, CandidateDialog, ScorecardDialog, PeopleDialog, InterviewDialog); routed through `useRoutedId` (ApplicationsPage.tsx:49) and App.tsx:490
Evidence: applications-detail-desktop.png, applications-detail-mobile.png, applications-detail-interviews-desktop.png, applications-detail-interviews-mobile.png, applications-status-dialog-desktop.png, applications-schedule-dialog-desktop.png, applications-schedule-dialog-mobile.png, applications-detail-hired-desktop.png

## Primary objective
Decide on one applicant: review who they are and how their interviews went, then change the stage (shortlist, offer, reject), schedule the next interview, or create a Eureka candidate once hired.

## What's on screen
- Wide drawer: title "Job · Applicant", status pill + overall rating, action row (Change status…, Schedule interview…, Create candidate… when allowed), 3 tabs (Job details · Applicant · Interviews (n)), then a History timeline below the tabs.
- Job details tab: 11-row facts list, Requirements, Description.
- Applicant tab: 5 facts (name, email, phone (masked by permission), applied, status since).
- Interviews tab: mini table (Type, Round, Slot, Status, Rating, Details/Review).
- Dialogs: Status (select + internal comment), Create interview (3 radios, 4 fields, multi-select panel, link), Create candidate, Review (4 × 1–5 radio groups + notes), Interview details (facts, reviews, Mark completed / no show / cancelled, Change lead or panel…), Lead and panel.

## Problems
| # | Problem (evidence: file:line / screenshot) | Category | Severity |
|---|---|---|---|
| 1 | The drawer opens on **Job details** (ApplicationsPage.tsx:151). A reviewer opening an application already knows the job; the applicant's contact details and interviews are behind 2 other tabs (applications-detail-desktop.png). | Hierarchy | High |
| 2 | Changing the status emails the applicant, but the dialog does not say so. The only notice is the toast after saving ("The applicant was emailed.", ApplicationsPage.tsx:245). The select also preselects the first allowed transition (ApplicationsPage.tsx:256; "Offered" in applications-status-dialog-desktop.png), so Enter sends an offer email. | Cognitive | High |
| 3 | The Review dialog preselects 3 on all four criteria (ApplicationsPage.tsx:359), so "Save review" without touching anything stores a 3/3/3/3 scorecard that looks like a real assessment and feeds "Overall rating". | Cognitive | High |
| 4 | The Panel picker is a `<select multiple>` that needs Ctrl/Cmd (ApplicationsPage.tsx:310-312, :389-391). The global `.field select { height:40px }` (styles.css:204) clamps it to 2 visible options (applications-schedule-dialog-desktop.png). On touch devices multi-select with Ctrl is not possible. | A11y | High |
| 5 | Moving through the queue takes close → find the next row → Open, because the drawer has no previous/next control. | Efficiency | Medium |
| 6 | Tabs use `role=tab` but without roving `tabIndex` or arrow keys (ApplicationsPage.tsx:178-184). CandidateProfile does this correctly (sales/CandidateProfile.tsx:204). `aria-controls` points to panel ids that are not rendered for inactive tabs. | A11y | Medium |
| 7 | "Mark cancelled" / "Mark no show" run immediately with no confirmation (ApplicationsPage.tsx:422-426) and sit next to "Close". Cancelling an interview has external impact. | Cognitive | Medium |
| 8 | Stage changes need 3 interactions (Change status… → select → Save) even for the 2 most common moves (shortlist, reject). | Efficiency | Medium |
| 9 | The action row uses `btn sm` (30px desktop / 34px mobile) for the primary decisions, so they have the same weight as row actions. The status is a small pill at the top left. | Hierarchy | Medium |
| 10 | The default interview slot is "now + 24h" to the minute (ApplicationsPage.tsx:282), e.g. 02:46 AM (applications-schedule-dialog-desktop.png), which nearly always needs editing. The trigger reads "Schedule interview…" but the dialog title and submit read "Create interview" (ApplicationsPage.tsx:299, :315). | Cognitive | Low |
| 11 | History is placed below the tab panel and only shows when non-empty (ApplicationsPage.tsx:226), so on the Job tab it sits under a long description (applications-detail-mobile.png). | Hierarchy | Low |

## Recommended redesign
### Desktop
- Header block: applicant name (H2), job · company, status pill, overall rating. Below it, a **stage bar**: one button per `actions.transition` (e.g. "Shortlist", "Offer", "Reject" with danger style) at standard `.btn` height. Clicking opens the existing StatusDialog prefilled with that target, showing "The applicant will be emailed about this change." above the comment. No preselected default.
- Secondary actions: "Schedule interview" (dialog title and submit renamed to match), "Create candidate" (primary only when hired).
- Default tab **Overview** = Applicant facts + Interviews table + History. "Job" becomes the second tab. Implement roving tabindex and arrow keys as CandidateProfile does.
- Prev/next arrows in the drawer header that step through the current page's `items` (already in memory; `setOpenId`).
- Review dialog: no preselected ratings; require all 4 (submit disabled with the reason "Rate all four areas").
- Panel picker: checkbox list (scrollable, max-height 200px) or a combobox with chips. Override `.field select[multiple] { height:auto }` at least.
- Interview dialog: "Mark cancelled" and "Mark no show" go through `ConfirmDialog`.
- Round the default slot to the next full hour, tomorrow 10:00 local.
### Mobile
- Drawer is already full-width. Make the stage bar a sticky bottom bar (≥44px buttons) so decisions stay reachable while scrolling History.
### Reusable components
- Existing: `ConfirmDialog`, `Dialog`, `Field`, `AppStatus`, roving-tab pattern from CandidateProfile.
- New shared: `Tabs` component (role, roving tabindex, arrows) to replace hand-rolled tablists; `MultiPersonPicker` (checkbox list), also useful wherever `select multiple` is used.

## Before/after interaction comparison
| Task | Before | After |
|---|---|---|
| See an applicant's contact + interview results | Open → Applicant tab → Interviews tab (3) | Open (1; Overview shows both) |
| Reject an applicant | Change status… → pick "Rejected" in the select → Save (3) | Reject → Save (2), with the email consequence shown |
| Review the next application | Close → find the row → Open (3) | Next arrow (1) |
| Add 2 panelists on a phone | Not possible (Ctrl-click) | Tick 2 checkboxes (2) |
| Leave a review | Can save untouched 3s (1, wrong data) | Must rate 4 areas (4, correct data) |

## Expected benefit
Fewer accidental offer/reject emails and fake ratings. Faster queue review, and scheduling works on touch.

## Implementation complexity: M
ApplicationsPage.tsx only for the drawer and dialogs; styles.css for `select[multiple]`. A new shared Tabs component is optional. No API changes: transitions, panel ids and scorecard endpoints are unchanged.

## Scorecard
| Dimension | Score | Evidence |
|---|---|---|
| Usability | 5 | Silent email consequence + preselected status (#2), fake default scores (#3) |
| Visual hierarchy | 5 | Opens on the job, not the applicant (#1); decisions are small buttons (#9) |
| Efficiency | 5 | 3-step stage change (#8), no prev/next (#5) |
| Responsiveness | 6 | Drawer fills the phone; panel picker unusable on touch (#4); actions scroll away |
| Accessibility | 5 | Ctrl-only multi-select clamped to 40px (#4, WCAG 2.1.1 risk on touch), incomplete tabs pattern (#6) |
| Design consistency | 6 | Tabs differ from CandidateProfile (#6); "Schedule" vs "Create interview" (#10) |

## Validation
Visual inspection: desktop 1440 + mobile 390 as hr on seeded application 199cb25b… (interview scheduled) and fd848f9a… (hired); Status and Create interview dialogs opened (not submitted, so no data changed). Redesign validation: pending (not implemented).

# Applications — `/applications`
Status: Audited · Redesign proposed
Who / permission: `application:read` (HR, all), `job:read` (hiring managers: their jobs), `interview:read` (interviewers: those they review) (nav.ts:23). Export needs `application:read` (ApplicationsPage.tsx:63). The record view is audited separately in `application-detail.md`.
Source: apps/web/src/jobs/ApplicationsPage.tsx:35-139, applicationsApi.ts, jobs.css; ui/Pager.tsx, sales/ui.tsx
Evidence: applications-desktop.png (ceo, empty), applications-mobile.png, applications-hr-desktop.png, applications-hr-mobile.png

## Primary objective
The hiring team triages the incoming queue: it finds new ("Applied") applications for a job, opens one, and moves it forward or rejects it.

## What's on screen
- Page head: H1, subtitle, "Export" (CSV download, application:read).
- Filters: Status chip group (All + 7 statuses = 8 chips), "Applicant" search, "Job" select (only when the user has job:read and internal openings exist), "Clear filters". Filters are kept in the URL (`?status=&jobId=&q=`; ApplicationsPage.tsx:41-45).
- Table: 7 columns (Job title, Applicant with avatar + email, Company, Applied, Overall rating, Status, "Open" `btn sm`). Cursor pager, 50 per page, live count.
- Empty state: "No applications for you yet." (ceo sees nothing: applications-desktop.png).

## Problems
| # | Problem (evidence: file:line / screenshot) | Category | Severity |
|---|---|---|---|
| 1 | At 390px only Job title and part of the Applicant column are visible. **Status**, the main triage field, and the "Open" button are off-screen with no scroll hint (applications-hr-mobile.png; sticky first column styles.css:958). Opening an application on a phone means swiping the table sideways first. | Responsive | High |
| 2 | Row order puts Job title first and repeats it on every row ("HR Generalist" twice; applications-hr-desktop.png). The applicant, the thing being triaged, is second, and the sticky mobile column is the job, not the person. | Hierarchy | Medium |
| 3 | The only way to open a record is the 56×30 "Open" button at the far right (ApplicationsPage.tsx:124). The applicant name is not a link. | Efficiency | Medium |
| 4 | 8 status chips wrap to 3 rows on mobile (applications-hr-mobile.png) and show no counts, so "how many new applications?" needs a click per status. | Efficiency | Medium |
| 5 | The page leads with the "All" status. A queue screen should open on the actionable set (Applied/Shortlisted). Rejected, withdrawn and hired rows mix in and need a manual chip click each visit (ApplicationsPage.tsx:43). | Efficiency | Medium |
| 6 | Export errors appear in the `.livemsg` box, which is always green/success-styled (styles.css:190; ApplicationsPage.tsx:76-77), so a failure looks like a success. | Visual | Medium |
| 7 | The "Overall rating" column shows "—" on every seeded row (applications-hr-desktop.png) and takes 113px. It is only meaningful after a scorecard exists. | Hierarchy | Low |
| 8 | The Job filter appears only when `jobs.data.items.length > 0` (ApplicationsPage.tsx:95), so for interviewers without job:read the filter row layout changes, and they cannot narrow by job. | Cognitive | Low |
| 9 | The empty state "No applications for you yet." gives no next step. For a CEO who cannot see any applications it reads as "none exist" rather than "not in your scope" (applications-desktop.png). | Cognitive | Low |

## Recommended redesign
### Desktop
- Column order: **Applicant** (name as `.linkbtn` that opens the drawer, email below) · Job (title, company below) · Applied · Status · Rating (only when any row has one). Drop the separate Company column and the "Open" button.
- Status filter: an "Active" default (Applied + Shortlisted + Interview scheduled + Offered) plus the individual statuses. Counts per status would need an API change (not proposed). Without counts, keep the chips but order them by workflow and put "Rejected / Withdrawn / Hired" behind "Closed ▾".
- Keep the URL-held filters (good existing behaviour).
- Show errors in an error-styled live region (`.error[role=alert]`) instead of `.livemsg`.
### Mobile
- Card list at ≤768px: applicant name (tap target = whole card, ≥44px), job · applied date, status pill on the right.
- Status filter as a `<select>` (or a horizontally scrolling chip row with one line height), so the list starts above the fold.
### Reusable components
- Existing: `AppStatus` badge, `Person`, `.linkbtn`, `useSearchParam`, `Pager`.
- New shared: `ResponsiveTable` card mode (same need as jobs, applicants, portal), a `Notice` with success/error variants to replace raw `.livemsg` usage.

## Before/after interaction comparison
| Task | Before | After |
|---|---|---|
| Open the newest application on a phone | Swipe the table sideways, tap the 30px "Open" (2) | Tap the card (1) |
| See only actionable applications | Click "Applied", then "Shortlisted" etc. one at a time (only single-select) | Default "Active" view (0) |
| Identify the applicant in a row | Read past the repeated job title | Applicant is the first column |

## Expected benefit
Triage works on a phone. The default view is the work queue. One click to open a record.

## Implementation complexity: S–M
ApplicationsPage.tsx (columns, linkbtn, default filter), styles.css (card mode, shared). An "Active" multi-status filter needs the API to accept several statuses; if `status` only accepts one value, keep single-select chips (no API change) and only reorder them.

## Scorecard
| Dimension | Score | Evidence |
|---|---|---|
| Usability | 6 | Filters in the URL and deep links work; the default view is not the queue (#5) |
| Visual hierarchy | 6 | Job title before the applicant (#2); empty rating column (#7) |
| Efficiency | 6 | Single small Open button (#3); no counts (#4) |
| Responsiveness | 4 | Status and Open off-screen at 390px (#1); chips take 3 rows (#4) |
| Accessibility | 7 | `aria-pressed` chip group with label, labelled search, live count, descriptive `aria-label` on Open; errors in a success-styled region (#6) |
| Design consistency | 7 | Same list pattern as Jobs/Applicants; misuse of `.livemsg` for errors is shared (#6) |

## Validation
Visual inspection: desktop 1440 and mobile 390 as ceo (empty) and hr (3 seeded applications). No page-level horizontal overflow; smallest targets 30px (desktop), 34px (mobile). Redesign validation: pending (not implemented).

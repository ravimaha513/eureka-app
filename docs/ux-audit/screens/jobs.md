# Jobs — `/jobs`
Status: Audited · Redesign proposed
Who / permission: `job:read` (nav.ts:21). Create/edit: `job:manage` (JobsPage.tsx:52) plus per-row `actions.edit`. Seen as ceo (2 client requirements only) and hr (4 internal openings, "Add job" offered, internal-opening type only).
Source: apps/web/src/jobs/JobsPage.tsx, JobDialog.tsx, RichText.tsx, jobsApi.ts, jobs.css; shared ui/Dialog.tsx, sales/ui.tsx (Drawer, Field)
Evidence: jobs-desktop.png, jobs-mobile.png, jobs-detail-desktop.png, jobs-detail-mobile.png, jobs-hr-desktop.png, jobs-hr-mobile.png, jobs-dialog-desktop.png, jobs-dialog-mobile.png, jobs-dialog-mobile-full.png, jobs-dialog-errors-desktop.png

## Primary objective
Recruiters, leads and HR scan open requirements and openings (who the client is, deadline, how many applicants) and open one. HR/managers create, edit and publish internal openings to the careers portal.

## What's on screen
- Page head: H1, one-line subtitle, "Add job" primary (job:manage only).
- Filters: 2 labelled chip groups (Type: 3 chips, Status: 5 chips), 1 "Job title" search, conditional "Clear filters". At 1440px the filters use about 185px of height (y 165–350) before the first row (jobs-hr-desktop.png).
- Table: 7 columns (Job title + kind/portal subline, Client/company, Hiring manager, Deadline, Applicants, Status, actions with View + Edit `btn sm`, 30px tall). Cursor pager, 50 per page, and a live count line.
- View drawer (wide): status + "On careers portal" badge, 11-row facts list, Requirements, Description, "Edit job".
- Create/Edit dialog (`.dialog.wide`): 18 controls (title, 3 selects, 2 radio groups, date, hours, pay amount, pay frequency, pay currency, company/client, location, hiring manager, skills tag input, 2 rich-text editors, publish checkbox). Scroll height 1102px in an 808px dialog on desktop, 1589px in 810px on mobile.

## Problems
| # | Problem (evidence: file:line / screenshot) | Category | Severity |
|---|---|---|---|
| 1 | Publishing to the external careers portal is the last control in a 1102px-tall dialog (JobDialog.tsx:215-218), below two rich-text editors, and Status defaults to "Open" (JobDialog.tsx:78). One "Create job" click can put a half-written opening live for candidates, and the publish state is not visible when the dialog opens (jobs-dialog-desktop.png). | Hierarchy | High |
| 2 | Backdrop mousedown or Escape closes the 18-field form with no unsaved-changes check (ui/Dialog.tsx:27, :52), so all input is lost on a stray click outside the 860px dialog. | Efficiency | High |
| 3 | At 390px only Job title and Client/company are visible. Deadline, Applicants, Status and the View/Edit buttons are off-screen to the right of a sticky first column (styles.css:958), and nothing shows that the table scrolls (jobs-mobile.png, jobs-hr-mobile.png). | Responsive | High |
| 4 | Rows are not clickable and the title is plain `<b>` (JobsPage.tsx:101). Opening a job needs the 54×30 "View" button at the far right edge, which is the only target. | Efficiency | Medium |
| 5 | The job drawer is not routed: App.tsx:489 passes no `initialOpenId`, so `/jobs/<id>` does not open the job, and a job cannot be linked or shared, unlike `/applications/<id>` (App.tsx:490). | Efficiency | Medium |
| 6 | The Applicants count is plain text (JobsPage.tsx:105), but Applications already filters by `?jobId=` (ApplicationsPage.tsx:44). Reaching a job's applicants takes 4 steps: navigate, open the Job select, find the title, select it. | Efficiency | Medium |
| 7 | Pay is split across 3 controls that wrap onto different grid rows (amount, then frequency, then currency on the next row; JobDialog.tsx:172-180; jobs-dialog-desktop.png). The value "68 / hourly / USD" is never read as one unit. | Cognitive | Medium |
| 8 | 18 fields with no section headings: `.formsection` exists (jobs.css:31) but is unused here. Basics, terms, pay, people and content run together. "Type: Internal opening" sits 0px above "Job title" (JobDialog.tsx:145-146; jobs-dialog-desktop.png). | Hierarchy | Medium |
| 9 | The filter block spends 3 stacked rows (Type chips, Status chips, search) on 2 low-cardinality filters. On mobile the status chips wrap to 2 rows and the table starts at y=413 (jobs-mobile.png). | Efficiency | Medium |
| 10 | Long dialogs have no sticky footer: `.actions` is static (styles.css:324), so on mobile "Create job" is about 780px below the fold (jobs-dialog-mobile-full.png). | Responsive | Medium |
| 11 | Portal status is shown only as muted secondary text "· on careers portal" (JobsPage.tsx:101). It cannot be filtered on, and it is easy to miss when checking what candidates see. | Hierarchy | Low |
| 12 | `.dialog.wide` is defined twice with different widths (styles.css:584 = 700px, jobs.css:30 = 860px), so the width depends on CSS load order. | Visual | Low |
| 13 | Row action buttons are 30px tall on desktop and 34px on mobile (`.btn.sm`, styles.css:209). They pass the 24px minimum but miss the 44px touch guidance. | A11y | Low |

## Recommended redesign
### Desktop
- One-line filter bar: `Type` segmented control (All · Client requirement · Internal opening; hide it when the user can see only one kind), `Status` select with "Open" as a quick chip, search, Clear. This saves about 110px of vertical space.
- Make the title a `.linkbtn` that opens the drawer, keep Edit as the only row button, and drop "View".
- Route the drawer: accept `initialOpenId`/`onOpenChange` the way ApplicationsPage does, so `/jobs/<id>` works.
- Make the Applicants cell a link to `/applications?jobId=<id>` when the user can see applications (job:read already satisfies the nav anyOf).
- Show a "Portal" badge (`.badge.kind`) in the Status cell next to the status pill instead of muted text.
- Dialog: split into sections with `.formsection` headings: **Basics** (title, category, experience), **Terms** (employment type, work mode, location, hours, deadline), **Pay** (one row: amount | frequency | currency), **People** (client/company, hiring manager), **Content** (skills, requirements, description). Move **Status + "Publish on careers portal"** into a top "Visibility" row. Default the status to Draft for new jobs. Change the submit label to match the state: "Create draft" / "Create and publish".
- Dialog primitive: track a dirty flag and ask before closing on backdrop/Escape when it is dirty (shared ui/Dialog.tsx change). Make the `.actions` footer sticky in `.dialog`.
### Mobile
- Replace the table with a card list at ≤768px: title (link), employer · deadline, status pill + applicants count, and Edit as a 44px button. Alternatively keep the table but show Status as the second column.
- Collapse the filters into a "Filters (n)" disclosure with search always visible.
- Make the dialog full-screen with a sticky footer.
### Reusable components
- Existing: `Drawer`, `Field`, `.linkbtn`, `.badge.kind`, `useRoutedId` (lib/router), `.formsection`, `Pager`.
- New shared: `DirtyGuard` in `Dialog` (prop `dirty`), sticky `.dialog .actions`, `ResponsiveTable`/card-list pattern for ≤768px (needed by every list screen).

## Before/after interaction comparison
| Task | Before | After |
|---|---|---|
| Open a job | Find the row, click the 54px "View" at the far right (1 precise click) | Click the title (1 click, large target) |
| See a job's applicants | Nav → Applications → Job select → pick the title (4) | Click the count (1) |
| Create and publish an opening | Fill 18 fields, scroll to the bottom, tick publish, check Status (default Open), Create (≈ 3 scrolls) | Visibility row at the top; "Create and publish" (0 scrolls to find it) |
| Share a job with a colleague | Not possible | Copy the `/jobs/<id>` URL |
| Check status on a phone | Swipe the table sideways to find Status | Visible on the card |

## Expected benefit
Prevents accidental publishing to candidates and lost forms. Opening a job or its applicants becomes one click. Status is readable on phones.

## Implementation complexity: M
JobsPage.tsx, JobDialog.tsx, App.tsx (pass routed id), ui/Dialog.tsx (dirty guard and sticky actions, shared), styles.css/jobs.css (mobile cards, duplicate `.dialog.wide`). No API changes: list filters, `jobId` param and publish field already exist.

## Scorecard
| Dimension | Score | Evidence |
|---|---|---|
| Usability | 6 | Works, but publish is buried and defaults to Open (#1), and forms are lost on backdrop click (#2) |
| Visual hierarchy | 6 | Clean table; 185px of filters before data (#9); flat 18-field form (#8) |
| Efficiency | 5 | 1-click open only via the small button (#4), no jobs → applicants link (#6), no deep link (#5) |
| Responsiveness | 4 | Status and actions off-screen at 390px (#3); submit 780px below the fold (#10) |
| Accessibility | 7 | Labelled filters (`aria-pressed` groups), live count, focus after failure; targets 30–34px (#13) |
| Design consistency | 6 | Applications routes its drawer but Jobs does not (#5); duplicate `.dialog.wide` (#12) |

## Validation
Visual inspection: desktop 1440 and mobile 390 as ceo and hr (list, drawer, create dialog, empty-submit validation). Measured: no horizontal page overflow; smallest targets 30px (desktop) / 34px (mobile); dialog scroll 1102/808 (desktop), 1589/810 (mobile). Redesign validation: pending (not implemented).

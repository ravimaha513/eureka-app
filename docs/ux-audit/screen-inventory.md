# Eureka web: screen inventory

Phase 1 (Discovery). Built from `apps/web/src/nav.ts`, `App.tsx`, `main.tsx` and the screen components, and checked against the running app: local stack with seeded fictional data, signed in as each role.

## How routing works
- **Staff app** (`App.tsx`). Each screen is at `/<key>` and an open record at `/<key>/<id>` (`nav.ts` `screenPath`/`parseScreenPath`). Which screens a user sees comes from `visibleNav(capabilities)`. This only controls what is shown; the API does the real authorization. Users land on the **Hot List**, or on their first visible screen if they have no Hot List.
- **Applicant portal** (`portal/PortalApp.tsx`) is a separate chunk at `/portal/*` with its own session.
- **Public feedback form** (`feedback/PublicFeedback.tsx`) is at `/feedback/<token>`.
- **Shell features** on every signed-in route: sidebar (6 sections, can collapse to icons on desktop, off-canvas drawer on phones), top bar with notifications bell, user menu (Settings, theme, sign out), Ctrl/Cmd+K Quick jump, `/` to focus search, skip link, offline banner.

## Screens

Abbreviations in the "Seen by" column (from `nav.ts` `anyOf`, verified by signing in):
- **CEO**: ceo
- **Sales**: recruiter, lead, manager, AD
- **LocOps**: location ops / in-charge
- **HR**, **Acct** (accounts), **Imm** (immigration), **Coach**, **IL** (interview lead), **Admin** (org admin)

| # | Screen | Route | Source | Seen by | Records / sub-views | Report |
|---|---|---|---|---|---|---|
| 1 | Sign in / Set password / Change password | `/`, `/set-password#token`, forced change | `App.tsx:1-280` | everyone signed out | dev picker, password form, Google | [login](screens/login.md) |
| 2 | App shell | every route | `App.tsx:280-547`, `shell/*`, `nav.ts` | all staff | drawer, Quick jump, user menu | [shell](screens/shell.md) |
| 3 | Notifications | top-bar bell | `notifications/Inbox.tsx` | all staff | popover inbox | [notifications](screens/notifications.md) |
| 4 | Dashboard | `/dashboard` | `dashboard/DashboardPage.tsx`, `ui/Charts.tsx` | `report:read` (CEO, Sales, LocOps, HR, Acct, Imm) | KPI tiles, trend, funnel, "needs attention" tables | [dashboard](screens/dashboard.md) |
| 5 | **Hot List** (default landing) | `/hotlist`, `/hotlist/<id>` | `sales/HotListPage.tsx`, `HotListExtras.tsx`, `ListControls.tsx`, `useCandidateList.ts` | `hotlist:read` (Sales, CEO, LocOps, Coach) | saved views, bulk status and priority, quick view, profile | [hotlist](screens/hotlist.md) |
| 6 | Candidates | `/candidates`, `/candidates/<id>` | `sales/CandidatesPage.tsx`, `CreateCandidateDialog`, `BulkCandidatesForm` | `candidate:read` | create, bulk create | [candidates](screens/candidates.md) |
| 7 | Candidate profile | `/candidates/<id>`, `/hotlist/<id>` | `sales/CandidateProfile.tsx` + tabs (submissions, documents, training, work auth, activity) | as list | edit, log submission, delete, resumes | [candidate-profile](screens/candidate-profile.md) |
| 8 | Submissions | `/submissions` | `pipeline/SubmissionsPage.tsx`, `SubmissionRounds`, `ScheduleInterviewDialog`, `EditSubmissionDialog`, `CreatePlacementDialog` | `submission:read` | drawer with no URL, schedule, status, convert to placement | [submissions](screens/submissions.md) |
| 9 | Interviews | `/interviews`, `/interviews/<id>` | `interviews/InterviewsPage.tsx` | `interview:read` | read-only drawer; create, edit, feedback, clear and place | [interviews](screens/interviews.md) |
| 10 | Placements | `/placements` | `pipeline/PlacementsPage.tsx` | `placement:read` | — | [placements](screens/placements.md) |
| 11 | Placement detail | `/placements/<id>` | `pipeline/PlacementsPage.tsx` | as list | status, contacts, checklist, documents | [placement-detail](screens/placement-detail.md) |
| 12 | Preferred vendors | `/vendors` | `pipelinereport/PreferredVendorsPage.tsx` | `vendor.preferred:*` | — | [vendors](screens/vendors.md) |
| 13 | My team | `/myteam` | `team/MyTeamPage.tsx` | `team:add_member` (lead) | — | [myteam](screens/myteam.md) |
| 14 | Coach assignments | `/coaching` | `team/CoachingPage.tsx` | `coach:assign` (IL) | — | [coaching](screens/coaching.md) |
| 15 | Jobs | `/jobs` | `jobs/JobsPage.tsx`, `JobDialog`, `RichText` | `job:read` | drawer with no URL, create/edit, publish to portal | [jobs](screens/jobs.md) |
| 16 | Applications | `/applications` | `jobs/ApplicationsPage.tsx` | `application:read`, `job:read`, `interview:read` | — | [applications](screens/applications.md) |
| 17 | Application detail | `/applications/<id>` | `jobs/ApplicationsPage.tsx` | as list | status (emails applicant), review, interview | [application-detail](screens/application-detail.md) |
| 18 | Applicants | `/applicants` | `jobs/ApplicantsPage.tsx` | `applicant:read` (HR) | export | [applicants](screens/applicants.md) |
| 19 | Paperwork & BGC | `/paperwork` | `paperwork/PaperworkPage.tsx` | `document:read`, `bgc:update` | queue and templates | [paperwork](screens/paperwork.md) |
| 20 | Paperwork workspace | `/paperwork/<placementId>` | `paperwork/PaperworkWorkspace.tsx` | as list | documents, checklist, BGC, HR documents | [paperwork-workspace](screens/paperwork-workspace.md) |
| 21 | Documents section (shared) | inside 7, 11, 20 | `documents/DocumentsSection.tsx` | — | upload, link, view | [documents-section](screens/documents-section.md) |
| 22 | Employees | `/employees` | `employees/EmployeesPage.tsx` | `employee:read` (CEO, HR, Acct, Imm) | drawer with no URL, assignments | [employees](screens/employees.md) |
| 23 | DataHub | `/datahub` | `datahub/DataHubPage.tsx` | `datahub:read` | folders, upload, restricted members, step-up | [datahub](screens/datahub.md) |
| 24 | Payments | `/payments` | `payments/PaymentsPage.tsx` | `invoice:read` (CEO, Sales, Acct) | drawer, new invoice, record payment | [payments](screens/payments.md) |
| 25 | Companies / Facilities | `/companies`, `/facilities` | `sites/SitesPage.tsx` (shared), `SiteDrawer`, `PeopleTabs`, `UtilitiesTab`, `BillsTab` | `company:read`, `facility:read` (LocOps) | drawer with tabs | [companies-facilities](screens/companies-facilities.md) |
| 26 | Training Batches | `/training` | `training/TrainingPage.tsx` | `training:read` | — | [training](screens/training.md) |
| 27 | Training batch detail | `/training/<id>` | `training/BatchDetail.tsx`, `BulkCandidatesDialog` | as list | students, courses | [training-batch](screens/training-batch.md) |
| 28 | Courses | `/courses` | `training/CoursesPage.tsx` | `training:manage` | drawer | [courses](screens/courses.md) |
| 29 | Performance | `/performance` | `performance/PerformancePage.tsx` | `performance:read` | drill-down | [performance](screens/performance.md) |
| 30 | Reports (joinings and exits, market) | `/reports` | `employees/JoiningsExitsReport.tsx`, `MarketReport.tsx` | `report:read`, `report.market:read` | tabs | [reports](screens/reports.md) |
| 31 | Interview reports | `/interview-reports` | `interviews/InterviewReportsPage.tsx` | `report:read` and `interview:read` | tabs | [interview-reports](screens/interview-reports.md) |
| 32 | Candidate Pipeline report | `/pipeline` | `pipelinereport/PipelineReportPage.tsx`, `AssessmentsSection` | `report:read` | — | [pipeline](screens/pipeline.md) |
| 33 | Users & Access | `/access` | `admin/AccessPage.tsx`, `UsersTab`, `RolesTab`, `TeamsTab`, `OrgChartTab`, `LocationDetail`, `TeamDrawer` | `access:manage` (Admin) | 5 tabs, approvals | [access](screens/access.md) |
| 34 | Staff birthdays | `/birthdays` | `staff/BirthdaysPage.tsx` | `staff.birthday:manage` (HR) | — | [birthdays](screens/birthdays.md) |
| 35 | Chat | `/chat`, `/chat/<id>` | `chat/ChatPage.tsx` | `chat:use` | groups, members | [chat](screens/chat.md) |
| 36 | Settings & Preferences | `/settings` (user menu) | `settings/SettingsPage.tsx` | everyone | notifications, sessions, security | [settings](screens/settings.md) |
| 37 | Applicant portal | `/portal/*` | `portal/PortalApp.tsx`, `PortalJobs` | external applicants | jobs, apply, my applications | [portal](screens/portal.md) |
| 38 | Public interview feedback | `/feedback/<token>` | `feedback/PublicFeedback.tsx` | interviewee (token link) | — | [feedback-public](screens/feedback-public.md) |

The cross-cutting design-system inventory is in [screens/_system.md](screens/_system.md).

## Nav size per role (measured by signing in)
| Role | Nav items |
|---|---|
| CEO | 19 |
| Lead (l1), Recruiter (r1a) | 19 / 18 |
| LocOps (locD) | 16 |
| HR | 14 |
| Acct | 11 |
| Imm | 9 |
| Coach | 7 |
| Admin | 2 |

## Primary user journeys
1. **Recruiter daily loop.** Hot List → filter (technology, status, priority) → open profile → Log submission → Submissions → Schedule interview → Interviews → Clear and place → Placement.
2. **Shortlisting and triage.** Hot List → multi-select → bulk set status or priority → save the filter set as a view.
3. **Placement onboarding.** Placements → Paperwork workspace → checklist, documents, BGC → Employees.
4. **Hiring (jobs portal).** Jobs → publish → applicant applies on the Portal → Applications → review, status (emails the applicant), schedule interview.
5. **Back office.** Payments (invoices and payments); Companies/Facilities (utilities, bills); DataHub (files).
6. **Leadership.** Dashboard → Performance → Reports, Pipeline, Interview reports.
7. **Admin.** Users & Access (users, roles, teams, org chart, approvals).

## State coverage (summary; per-screen detail is in each report)
- **Loading:** the shared `Loading` component is used 63 times; 25 places show a raw "Loading…" text instead.
- **Error:** `QueryError` with Retry is used 38 times; 118 places use an ad-hoc `.error` paragraph with no retry.
- **Empty:** a shared `.empty` style with an icon exists and is used widely.
- **Success:** `.livemsg` is always styled as green success, including for errors and for "Uploading…".

## Audit status checklist
Legend: ☐ not done · ☑ done · ◐ partial. The rebrand identity (tokens, type, mark, buttons, fields, tables, chips, tabs) applies to every screen as of 2026-11-05. Layout redesigns are approved per screen.

| Screen | Not audited | Audited | Redesign proposed | Approved | Implemented | Validated |
|---|---|---|---|---|---|---|
| Hot List | | ☑ | ☑ | ☑ | ☑ | ◐ in review |
| Candidates | | ☑ | ☑ | ☑ | ☑ | ◐ in review |
| Candidate profile | | ☑ | ☑ | ☐ | ☐ | ☐ |
| Submissions | | ☑ | ☑ | ☐ | ☐ | ☐ |
| Interviews | | ☑ | ☑ | ☐ | ☐ | ☐ |
| Placements | | ☑ | ☑ | ☐ | ☐ | ☐ |
| Placement detail | | ☑ | ☑ | ☐ | ☐ | ☐ |
| Dashboard | | ☑ | ☑ | ☐ | ☐ | ☐ |
| App shell | | ☑ | ☑ | ☑ | ◐ identity only (nav regroup and phone drawer pending) | ☐ |
| Notifications | | ☑ | ☑ | ☐ | ☐ | ☐ |
| Login | | ☑ | ☑ | ☑ | ☑ (brand panel, theme label, error placement) | ◐ in review |
| Jobs | | ☑ | ☑ | ☐ | ☐ | ☐ |
| Applications | | ☑ | ☑ | ☐ | ☐ | ☐ |
| Application detail | | ☑ | ☑ | ☐ | ☐ | ☐ |
| Applicants | | ☑ | ☑ | ☐ | ☐ | ☐ |
| Applicant portal | | ☑ | ☑ | ☐ | ☐ | ☐ |
| Public feedback | | ☑ | ☑ | ☐ | ☐ | ☐ |
| Paperwork & BGC | | ☑ | ☑ | ☐ | ☐ | ☐ |
| Paperwork workspace | | ☑ | ☑ | ☐ | ☐ | ☐ |
| Documents section | | ☑ | ☑ | ☐ | ☐ | ☐ |
| Employees | | ☑ | ☑ | ☐ | ☐ | ☐ |
| Payments | | ☑ | ☑ | ☐ | ☐ | ☐ |
| Companies / Facilities | | ☑ | ☑ | ☐ | ☐ | ☐ |
| DataHub | | ☑ | ☑ | ☐ | ☐ | ☐ |
| Training Batches | | ☑ | ☑ | ☐ | ☐ | ☐ |
| Training batch detail | | ☑ | ☑ | ☐ | ☐ | ☐ |
| Courses | | ☑ | ☑ | ☐ | ☐ | ☐ |
| Performance | | ☑ | ☑ | ☐ | ☐ | ☐ |
| Reports | | ☑ | ☑ | ☐ | ☐ | ☐ |
| Interview reports | | ☑ | ☑ | ☐ | ☐ | ☐ |
| Candidate Pipeline | | ☑ | ☑ | ☐ | ☐ | ☐ |
| Users & Access | | ☑ | ☑ | ☐ | ☐ | ☐ |
| Staff birthdays | | ☑ | ☑ | ☐ | ☐ | ☐ |
| Preferred vendors | | ☑ | ☑ | ☐ | ☐ | ☐ |
| My team | | ☑ | ☑ | ☐ | ☐ | ☐ |
| Coach assignments | | ☑ | ☑ | ☐ | ☐ | ☐ |
| Chat | | ☑ | ☑ | ☐ | ☐ | ☐ |
| Settings | | ☑ | ☑ | ☐ | ☐ | ☐ |

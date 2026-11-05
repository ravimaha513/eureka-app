# Eureka web: UX/UI audit report (Phase 2)

Status: audit complete for all 38 screens and surfaces. **No code has been changed.** Approval is needed before any redesign is implemented.

## Method
- **Rubric:** Impeccable `audit` (a11y, theming, responsive, implementation integrity) plus `critique` heuristics (hierarchy, cognitive load). The product is in Operate mode (`reference/operate.md`): density and scan speed outrank whitespace.
- **Live inspection:**
  - Ran the full stack locally: PG16, API and Vite with the repo's fictional seed data.
  - Signed in as 12 roles (ceo, r1a, l1, m1, locD, hr, acct, imm, coach, il, admin, coord).
  - Captured **about 230 screenshots** at 1440×900 and 390×844, including dialogs, drawers, tabs, focus states and dark theme. They are in `screenshots/before/`.
- **Measurements:**
  - Overflow (`scrollWidth` against `clientWidth`).
  - Target sizes (`getBoundingClientRect`).
  - Contrast ratios computed from the CSS tokens.
  - Tab-order counts.
- **Six independent area audits:** sourcing, pipeline, hiring and portal, operations, insights/training/admin, and shell plus design system. Each uses a shared rubric with fixed scoring anchors (in each report's Scorecard section) so scores compare across screens. I re-checked the load-bearing claims myself, for example that `useCandidateList.ts:37-44` keeps filters in `useState` while `lib/router.ts:52` already provides a `useSearchParam` hook that 4 other screens use.
- **Deterministic detector:** `impeccable detect` found 4 issues. Verdicts are in [screens/_system.md §6](screens/_system.md).

**Scoring anchors:**
| Score | Meaning |
|---|---|
| 9–10 | No Medium-or-worse issue |
| 7–8 | Only Low or Medium issues |
| 5–6 | One High issue or several Medium |
| 3–4 | A Critical issue or several High |
| 1–2 | Broken |

## Limitations
These are stated per report as well.
- **Seed data had no rows for these:**
  - Invoices (Payments)
  - DataHub and Documents files
  - Preferred vendors
  - `feedback_delivery` tokens

  Those populated states were reviewed from source. The feedback form was rendered with a mocked `GET`.
- **No real devices.** Mobile means Chromium emulating a 390px viewport. Touch gestures were not exercised on hardware.
- **No screen-reader run.** Accessibility evidence comes from semantics, ARIA, keyboard, focus and contrast, not from NVDA or VoiceOver.
- **Seed data unchanged.** No destructive or external-effect actions were submitted: no apply, no status emails, no BGC fail.

## Headline numbers
- **Findings:** 4 Critical · 66 High · 152 Medium · 133 Low, across 38 screen reports plus 1 system report.
- **Average score by dimension (1–10):**

| Dimension | Average |
|---|---|
| Usability | 5.8 |
| Visual hierarchy | 5.7 |
| Efficiency | 5.3 |
| **Responsiveness** | **5.0** (weakest) |
| Accessibility | 6.4 |
| Consistency | 5.7 |

- **Lowest-scoring screens:**
  - **Interviews** and the **Hot List** are the two primary daily screens for recruiters and coaches, and they score lowest of all.
  - The Hot List is also the default landing page.

**Overall verdict:** the app works and is semantically careful. Dialogs trap focus, routes move focus to the h1, reduced-motion is respected, and nav is permission-aware. But it is built as a *form-and-table per feature* system with no shared answer to the four problems every screen has:
1. too many filters,
2. tables wider than the screen,
3. records that don't link to each other,
4. actions placed after the facts.

Each screen solved these locally, or didn't. The result is friction that repeats everywhere rather than any single broken screen.

## Scorecard (all screens, sorted worst first)
Columns are Usability, Hierarchy, Efficiency, Responsiveness, Accessibility and Consistency, then the average and the count of Critical and High findings.

| Screen | Route | Usab | Hier | Effic | Resp | A11y | Cons | **Avg** | Crit | High | Report |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Interviews | `/interviews` | 5 | 4 | 4 | 3 | 5 | 4 | **4.2** | 0 | 5 | [interviews](screens/interviews.md) |
| Hot List | `/hotlist` | 4 | 4 | 4 | 3 | 6 | 5 | **4.3** | 1 | 3 | [hotlist](screens/hotlist.md) |
| Users & Access | `/access` | 5 | 4 | 4 | 4 | 6 | 5 | **4.7** | 0 | 2 | [access](screens/access.md) |
| Dashboard | `/dashboard` | 5 | 4 | 5 | 4 | 5 | 5 | **4.7** | 0 | 4 | [dashboard](screens/dashboard.md) |
| Payments | `/payments` | 5 | 5 | 4 | 4 | 6 | 5 | **4.8** | 0 | 2 | [payments](screens/payments.md) |
| Candidate Pipeline | `/pipeline` | 5 | 6 | 4 | 3 | 6 | 5 | **4.8** | 0 | 2 | [pipeline](screens/pipeline.md) |
| Employees | `/employees` | 4 | 6 | 4 | 3 | 7 | 6 | **5.0** | 1 | 2 | [employees](screens/employees.md) |
| Submissions | `/submissions` | 6 | 6 | 4 | 3 | 7 | 5 | **5.2** | 0 | 4 | [submissions](screens/submissions.md) |
| Application detail | `/applications/<id>` | 5 | 5 | 5 | 6 | 5 | 6 | **5.3** | 0 | 4 | [application-detail](screens/application-detail.md) |
| Paperwork & BGC | `/paperwork` | 6 | 5 | 5 | 4 | 6 | 6 | **5.3** | 0 | 3 | [paperwork](screens/paperwork.md) |
| Paperwork workspace | `/paperwork/<id>` | 5 | 5 | 5 | 4 | 7 | 6 | **5.3** | 0 | 4 | [paperwork-workspace](screens/paperwork-workspace.md) |
| Performance | `/performance` | 5 | 6 | 5 | 5 | 6 | 5 | **5.3** | 0 | 1 | [performance](screens/performance.md) |
| Reports | `/reports` | 6 | 4 | 6 | 5 | 6 | 5 | **5.3** | 0 | 1 | [reports](screens/reports.md) |
| Candidates | `/candidates` | 6 | 6 | 5 | 4 | 7 | 5 | **5.5** | 0 | 2 | [candidates](screens/candidates.md) |
| Companies / Facilities | `/companies`, `/facilities` | 6 | 7 | 5 | 4 | 6 | 5 | **5.5** | 0 | 3 | [companies-facilities](screens/companies-facilities.md) |
| Notifications | top bar | 6 | 5 | 5 | 7 | 5 | 5 | **5.5** | 0 | 2 | [notifications](screens/notifications.md) |
| Applicant portal | `/portal/*` | 4 | 6 | 5 | 5 | 7 | 6 | **5.5** | 1 | 2 | [portal](screens/portal.md) |
| App shell | every route | 6 | 6 | 5 | 5 | 5 | 6 | **5.5** | 0 | 2 | [shell](screens/shell.md) |
| Staff birthdays | `/birthdays` | 6 | 6 | 5 | 4 | 6 | 7 | **5.7** | 0 | 1 | [birthdays](screens/birthdays.md) |
| Documents section | shared | 6 | 6 | 5 | 5 | 7 | 5 | **5.7** | 0 | 1 | [documents-section](screens/documents-section.md) |
| Public feedback | `/feedback/<token>` | 6 | 6 | 6 | 6 | 6 | 4 | **5.7** | 0 | 1 | [feedback-public](screens/feedback-public.md) |
| Jobs | `/jobs` | 6 | 6 | 5 | 4 | 7 | 6 | **5.7** | 0 | 3 | [jobs](screens/jobs.md) |
| Placements | `/placements` | 6 | 6 | 5 | 3 | 7 | 7 | **5.7** | 0 | 2 | [placements](screens/placements.md) |
| Candidate profile | `/candidates/<id>` | 6 | 5 | 6 | 5 | 7 | 6 | **5.8** | 0 | 2 | [candidate-profile](screens/candidate-profile.md) |
| Interview reports | `/interview-reports` | 6 | 6 | 5 | 5 | 6 | 7 | **5.8** | 0 | 1 | [interview-reports](screens/interview-reports.md) |
| Sign in / passwords | `/` | 6 | 5 | 7 | 8 | 4 | 5 | **5.8** | 1 | 2 | [login](screens/login.md) |
| Training batch detail | `/training/<id>` | 6 | 6 | 5 | 6 | 6 | 6 | **5.8** | 0 | 0 | [training-batch](screens/training-batch.md) |
| Applications | `/applications` | 6 | 6 | 6 | 4 | 7 | 7 | **6.0** | 0 | 1 | [applications](screens/applications.md) |
| Placement detail | `/placements/<id>` | 6 | 5 | 6 | 5 | 7 | 7 | **6.0** | 0 | 1 | [placement-detail](screens/placement-detail.md) |
| Training Batches | `/training` | 6 | 6 | 5 | 7 | 7 | 5 | **6.0** | 0 | 1 | [training](screens/training.md) |
| DataHub | `/datahub` | 6 | 6 | 6 | 6 | 8 | 5 | **6.2** | 0 | 1 | [datahub](screens/datahub.md) |
| Applicants | `/applicants` | 7 | 7 | 6 | 5 | 7 | 6 | **6.3** | 0 | 0 | [applicants](screens/applicants.md) |
| Chat | `/chat` | 7 | 7 | 7 | 6 | 6 | 5 | **6.3** | 0 | 1 | [chat](screens/chat.md) |
| Courses | `/courses` | 7 | 6 | 6 | 7 | 7 | 6 | **6.5** | 0 | 0 | [courses](screens/courses.md) |
| Settings | `/settings` | 7 | 6 | 6 | 7 | 8 | 6 | **6.7** | 0 | 0 | [settings](screens/settings.md) |
| Preferred vendors | `/vendors` | 7 | 7 | 6 | 6 | 7 | 7 | **6.7** | 0 | 0 | [vendors](screens/vendors.md) |
| Coach assignments | `/coaching` | 7 | 6 | 7 | 8 | 7 | 6 | **6.8** | 0 | 0 | [coaching](screens/coaching.md) |
| My team | `/myteam` | 8 | 7 | 7 | 8 | 8 | 7 | **7.5** | 0 | 0 | [myteam](screens/myteam.md) |

## Critical findings (4)
| # | Screen | Finding | Evidence |
|---|---|---|---|
| C1 | Hot List | At **1440px desktop** the table is 1540px wide inside a 1110px scroller. Stay, In person, Phone, Days and the only row action (Quick view) are off-screen on every row. | `HotListPage.tsx:94-123`; `hotlist-recruiter-desktop.png` |
| C2 | Employees | Table is 1203 / 1110px. The Open column, the only way into a record (rows aren't clickable), is clipped at 1440. | `EmployeesPage.tsx:170-205`; `employees-desktop.png` |
| C3 | Applicant portal | Signed-out visitors see an account wall with **no jobs**, and job deep links are lost after sign-in. A public jobs endpoint is needed (API change). | `PortalApp.tsx:134,181`; `portal-signedout-jobs-mobile.png` |
| C4 | Login | The theme chip shows "Light" but its accessible name is "Switch to dark theme". This fails WCAG 2.5.3 Label in Name (Level A). | `App.tsx:224-227` |

## Systemic issues (cross-screen, ranked by reach × severity)
| # | Pattern | Reach | Severity | Evidence |
|---|---|---|---|---|
| S1 | **Tables only scroll sideways.** `.tablewrap{overflow-x:auto}`, plus `min-width:640px` and a sticky first column at ≤768. There is no column priority, no card layout, and the row action is the last column. Result: the primary action is off-screen **on desktop** (Hot List, Employees, Submissions, Interviews, Payments, Access, Candidates) and on mobile on about 20 screens. | ~22 screens | Critical/High | `styles.css:329,656,958` |
| S2 | **Filter overload, always expanded, every filter equal weight.** Counts: Hot List 15 controls (first row at y=702 on desktop, y=1203 on mobile, 22 Tab presses to the first result); Placements 16; Employees and Interviews fill the first mobile screen. No active-filter summary, no "More filters" panel, no mobile sheet (the Dashboard alone has one). | ~10 list screens | High | `ListControls.tsx`, `.toolbar` `styles.css:191` |
| S3 | **State not in the URL.** Hot List and Candidates filters are lost on reload, even though `App.tsx:291` intends `location.search` to hold them and `useSearchParam` exists. Drawers have no URL on Submissions, Jobs, Employees, Payments and Sites. The selected profile tab isn't in the URL. | ~10 | High | `useCandidateList.ts:37-44`, `lib/router.ts:52` |
| S4 | **Records don't link to each other.** Candidate names are plain `<b>` on Submissions, Interviews and Pipeline. Rounds don't open interviews; interview drawers don't open the submission, candidate or placement; report rows can't be clicked through. On Pipeline it is a one-prop fix (`App.tsx:493` omits `onOpenCandidate`). | the whole pipeline | High | see submissions, interviews, pipeline and interview-reports reports |
| S5 | **Facts before actions in detail views.** Placement detail: status after 15 facts. Payments drawer: Record payment after 20 facts. Application detail opens on Job details. Paperwork workspace opens on Documents while items are overdue. Candidate profile: 7 zero-value metric tiles before Details. | 6 detail views | High | per-screen reports |
| S6 | **Irreversible or external-effect actions without guard rails:** <ul><li>BGC fail is final with no confirmation.</li><li>Portal "Apply now" applies in one tap.</li><li>Application status change emails the applicant without saying so beforehand.</li><li>Review dialog defaults every score to 3, so saving untouched stores fake 3/3/3/3.</li><li>18-field Job dialog closes on a backdrop click and loses input.</li><li>Delete sits next to the primary Log submission button.</li></ul> | 6 flows | High | `PaperworkWorkspace.tsx:451`, `PortalJobs.tsx:18`, `ApplicationsPage.tsx:245,359`, `ui/Dialog.tsx:52`, `CandidateProfile.tsx:192` |
| S7 | **Contrast and target failures in tokens:** <ul><li>`--faint` used as text: 2.37:1</li><li>Input borders: 1.33:1 (fails 1.4.11)</li><li>Dark primary button: 4.47:1</li><li>Dark bell count: 2.69:1</li><li>Inactive legend items: about 2:1</li><li>Too-small targets: `.btn.sm` 30px, `.linkbtn` 17px, `.chipx` 18px, native checkboxes 13px</li></ul> | global | High (AA) | `_system.md §5` |
| S8 | **Many look-alikes, no system:** <ul><li>25 font sizes</li><li>28 spacing values</li><li>20 radii</li><li>10 control heights</li><li>9 breakpoints</li><li>66 badge modifiers across 5 badge components</li><li>6 tab treatments (pill `.tab` is used for both navigation and filters)</li><li>6 search-input styles</li><li>3 hand-rolled popovers</li></ul> No global `:focus-visible`. The generic kit (`Field`, `Drawer`, `fmtDate`) lives in `sales/ui.tsx` and is imported by 17 areas. **Inter is declared but never loaded.** | global | Medium | `_system.md §1–3` |
| S9 | **Feedback states are inconsistent.** `.livemsg` is always green "success", including for export errors and "Uploading…". 25 raw "Loading…" texts and 118 ad-hoc `.error` paragraphs bypass `Loading`/`QueryError`, so there is no Retry. | ~15 | Medium | `styles.css:189` |
| S10 | **Tabs without a keyboard model** (`role=tab` with no arrow keys) on Placements, Reports, Interview reports, Applications and Batch detail. Access and Candidate profile do it right. | 6 | Medium (a11y) | per-screen reports |

## Prioritised issue backlog (Critical and High, grouped by fix)
The Medium and Low items (285) are in each screen report.

| Priority | Fix | Closes | Effort |
|---|---|---|---|
| P0 | Responsive DataTable pattern (S1): column priority tiers, row action pinned right and the whole row clickable, ≤768 card list | C1, C2 and about 20 High | M (shared CSS plus a small component; each screen adopts it) |
| P0 | FilterBar pattern (S2): 3–4 primary filters inline, "More filters" popover (desktop) or bottom sheet (mobile), active-filter chips with clear, result count, synced to the URL (S3) | Hot List, Candidates, Placements, Employees, Interviews, Payments | M |
| P0 | Login theme chip label | C4 | XS |
| P1 | Cross-record links (S4), including the one-prop Pipeline fix | Submissions, Interviews, Pipeline, Interview reports | S–M |
| P1 | Action-first detail layout (S5) | 6 detail views | S each |
| P1 | Guard rails (S6) | 6 flows | S each |
| P1 | Token contrast and target fixes (S7) | global AA | S |
| P1 | Shell: phone drawer as a real modal with focus trap; nav regrouped by use | shell | S–M |
| P1 | Dashboard: "Needs attention" first; honest funnel labelling; legend contrast | dashboard | M |
| P2 | Design-system consolidation (S8–S10): type, space and radius tokens; one StatusBadge; one Tabs; Popover; move the kit out of `sales/` | global | M–L (incremental) |
| P2 | Portal public jobs (C3) | portal | M, **needs an API change**, so it needs your sign-off |

## Top 10 highest-impact improvements
Impact is frequency of use × severity × number of screens reached.

1. **Make every table fit and act on desktop, and turn into cards on phones (S1).** Fixes the two Critical row-action clippings and about 20 High mobile findings with one pattern.
2. **Collapse the Hot List / Candidates filter wall into a FilterBar.** Search plus Technology, Status and Priority stay inline. The other 11 filters go under "More filters (n)", with active chips and a result count. On mobile: a search field and a Filters button that opens a bottom sheet. Results move from y=702 to about y=260 on desktop, and onto the first mobile screen.
3. **Persist list state in the URL** using the existing `useSearchParam`. Filters survive reload, Back and share. Drawers on Submissions, Jobs, Employees and Payments get `/<key>/<id>`, as Placements and Applications already have.
4. **Link the pipeline together.** Candidate ↔ submission ↔ interview ↔ placement links everywhere a name appears; clickable rows; drawers show related-record chips.
5. **Selection-driven bulk actions on the Hot List.** The bulk bar appears only when rows are selected (it is a sticky `.selectionbar` already styled at `styles.css:309`), and selection is kept across pages.
6. **Action-first detail views.** A next-step or status strip at the top of the Placement, Payment, Application and Paperwork views; Delete moved into a "More" menu; tabs opened to where the work is.
7. **Guard rails on irreversible or external actions.** Confirm BGC fail; a review step for portal Apply; "This emails the applicant" shown before Save; no preset review scores; unsaved-changes guard on long dialogs.
8. **Dashboard leads with work.** "Needs attention" first; KPI deltas honest ("New" when the previous count is 0 gets a better label); funnel relabelled as period activity; legend contrast.
9. **Shell.** A real modal phone drawer with focus trap and close button. Nav regrouped by job-to-be-done (Workspace / Hiring / Operations / Insights / Admin, Chat moved out of "Other"), so 19 items fit in the viewport. The top-bar magnifier labelled as the Quick jump.
10. **Token-level a11y and consistency pass.**
    - Contrast fixes: `--faint`, input borders, dark primary, bell count.
    - Global `:focus-visible`.
    - 24px minimum targets, 44px on touch.
    - A tone variant for `.livemsg`.
    - One StatusBadge.
    - One keyboard-complete Tabs.
    - Load Inter or switch to the system font stack.

## Implementation-integrity verdict
**Pass with drift.** The product-specific structure is real: domain-shaped screens, permission-aware nav, careful ARIA in dialogs. The login hero is the only generic, decorative surface (grid background, gradient logo, fake KPIs and funnel).

**Detector findings:**
| Location | Verdict |
|---|---|
| `styles.css:150` grid background | Valid. Login hero only. |
| `styles.css:18` Inter | Valid, but the real problem is that the font isn't loaded. |
| `styles.css:887` | False positive: a row-state stripe. It does need a non-colour cue. |
| `styles.css:910` | False positive: the org-chart tree line. |

## What works (keep)
- `ui/Dialog.tsx`: focus trap, Escape, return focus; used 88 times.
- Route changes focus the h1; skip link; `/` focuses search; Ctrl/Cmd+K Quick jump.
- `prefers-reduced-motion` is handled for every animation.
- Permission-aware nav, and the API does the real authorization (keep it that way).
- Dark theme exists end to end with tokenised status triplets.
- Placements, Applications, Paperwork and Submissions already put some state in the URL. That is the precedent for S3.
- My team, Coaching and Settings are compact and clear. Use them as references for density.

# Eureka web: redesign roadmap

Status: **proposed; waiting for approval.** Each wave needs your go-ahead before implementation, as the brief requires.

## Recommended first screen: Hot List (`/hotlist`)

Why it goes first:
1. **Most used, worst scored.** It is the default landing page for every sales role and coaches. It averages 4.3 / 10, the second-lowest score, and has one of the four Critical findings: the row action and four columns are off-screen at 1440px.
2. **It forces the patterns that unlock everything else.** FilterBar, DataTable (column priority, sticky action, mobile cards), URL state and SelectionBar together cover about 20 other screens. Building them here, against the hardest case (15 filters, 11+ columns, bulk actions), means later screens mostly adopt them.
3. **Cheap infrastructure already exists.** `useSearchParam` (`lib/router.ts:52`), `.selectionbar` (`styles.css:309`) and the Dashboard's bottom sheet are already in the code. No API change is needed.
4. **Candidates comes almost free.** It shares `useCandidateList`, `ListControls` and the table, so wave 1 fixes two screens.

### Hot List redesign in brief
Full detail is in [screens/hotlist.md](screens/hotlist.md).

| | Before | After |
|---|---|---|
| Find "P1 Java, Active" candidates | First row at y=702 desktop, y=1203 mobile; 22 Tab presses to reach the first result | Search, Technology, Status and Priority inline, so the first row is at about y=260. Mobile: search plus a "Filters (2)" sheet, results on the first screen. |
| Use a less common filter (Visa, Guest house…) | Always visible among 15 equal-weight selects | "More filters" popover or sheet; active ones show as chips |
| Bulk-set status for 5 candidates | Bar always visible with disabled controls; selection lost on page change | Bar appears when rows are selected; selection kept across pages; status and priority in one bar |
| Reach Phone / Days / Quick view at 1440 | Needs a horizontal scroll | Columns prioritised, action pinned right; row click opens the profile |
| Reload or share a filtered list | Filters lost | Filters in the URL |
| Scan a row's status | "Active" + "Open to all teams" + "Active/All Teams" sub-text | One status badge plus a visibility icon-chip with a text label |

**Trade-off.** Hiding 11 filters behind "More filters" adds one click for occasional filters. That is acceptable because active filters stay visible as chips, saved views restore them in one click, and the four primary filters cover the common query. I'll confirm the primary four with you; the proposal is Search, Technology, Status and Priority.

## Waves

Each wave works the same way:
1. Proposal per screen, already written in `screens/*.md`.
2. Your approval.
3. Implementation.
4. Typecheck, unit tests and the screen's e2e spec.
5. Before/after screenshots at desktop and mobile.
6. Report updated to Implemented / Validated.

| Wave | Screens | Shared work introduced | Complexity | API change? |
|---|---|---|---|---|
| **0. Quick wins** (one PR, low risk) | Login theme-chip label (C4); Pipeline `onOpenCandidate` prop (`App.tsx:493`); `.livemsg` tones; token contrast fixes (`--muted`, field border, dark primary, bell count); global `:focus-visible`; `.field select[multiple]` height; chat.css `.dot`/`.iconbtn.sm` leak | Tokens (colour only) | S | No |
| **1. Discovery** | **Hot List**, Candidates | FilterBar, DataTable pattern, SelectionBar, URL state, StatusBadge | M | No |
| **2. Candidate record** | Candidate profile (+ Documents section) | Tabs (keyboard, URL), ActionStrip, More menu (Popover) | M | No |
| **3. Pipeline** | Submissions, Interviews, Placements, Placement detail | RecordLink, drawer URLs, one scheduling form, unified time-zone copy | L | No |
| **4. Home and shell** | Dashboard, App shell, Notifications | nav regroup, modal phone drawer, chart tokens | M | No |
| **5. Hiring** | Jobs, Applications, Application detail, Applicants, Portal, Public feedback | Dialog `dirty` guard; review-score defaults; pre-save email notice | M (Portal public jobs: L) | **Portal C3 needs a public jobs endpoint**, so a separate decision |
| **6. Back office** | Paperwork queue and workspace, Employees, Payments, Companies/Facilities, DataHub | adopt DataTable, FilterBar, ActionStrip; BGC-fail confirm | L | No |
| **7. Insights and admin** | Performance, Reports, Interview reports, Users & Access, Birthdays, Training, Batch, Courses, Vendors, My team, Coaching, Chat, Settings | adopt patterns; row More menus on Access | M | Settings sign-in method label: small API fix (`settings.service.ts:48`) |
| **8. Cross-screen consistency** | all | Type, spacing and radius token migration; remove dead CSS; final review across all redesigned screens together | M | No |

**Order rationale:**
- Wave 0 removes AA failures cheaply.
- Waves 1–3 follow the recruiter's daily loop (Hot List → profile → submission → interview → placement), where most time is spent and links are most broken.
- Wave 4 follows once the patterns it needs exist.
- Back office and admin come later: fewer users, and they mostly adopt patterns already built.

## Decisions I need from you
1. **Approve the design direction:** refine the incumbent ("quiet ledger") rather than rebrand.
2. **Font:** the system UI stack (recommended) or self-hosted Inter.
3. **Approve Wave 0** (quick wins) and **Wave 1** (Hot List + Candidates) for implementation.
4. **Hot List primary filters:** Search, Technology, Status, Priority?
5. **Nav regroup:** OK to reorder sections in `nav.ts`? This is ordering only; permissions are unchanged.
6. **Portal public jobs (C3):** it needs a new API endpoint. Include it in Wave 5, or leave it out of scope?

## Validation plan per screen
- `pnpm -r typecheck` and `pnpm --filter @eureka/web test`.
- The relevant `apps/web/e2e/*.spec.ts` against the local stack. Selectors stay stable, or the spec is updated where markup changes, keeping the `getByRole("combobox", { name, exact: true })` rule.
- Playwright before/after screenshots at 1440×900 and 390×844, light and dark.
- Re-measure overflow, target sizes and Tab count to first result.
- Re-run `impeccable detect`.
- Re-score with the same anchors; record the delta in the screen report.

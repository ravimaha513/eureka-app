# Candidates — `/candidates`
Status: Audited · Redesign proposed
Who / permission: `candidate:read` (nav.ts:16). "New candidate" needs `candidate:create` (not r1a); "New batch" when the batch list returns `canCreate`.
Source: `apps/web/src/sales/CandidatesPage.tsx`, `ListControls.tsx`, `useCandidateList.ts`, `CreateCandidateDialog.tsx`, `BulkCandidatesForm.tsx`, `HotListPage.tsx:25-41` (CandidateName)
Evidence: `candidates-desktop.png`, `candidates-desktop-full.png`, `candidates-mobile.png`, `candidates-mobile-full.png`, new: `candidates-recruiter-desktop.png`, `candidates-create-dialog-desktop.png`

## Primary objective
Find any candidate in one's scope (including in-training / terminated ones not on the Hot List) and open the profile; for leads/ops, add one or many candidates.

## What's on screen
- `.pagehead`: h1, subtitle, New batch + New candidate (primary) right-aligned.
- Filters: 2 text inputs + 9 selects (Status, Visibility, Batch, Location, Visa, Documents, Resume, Stay) = **11 controls**, 3 rows at 1440px; no Sort, no Priority/Team/Recruiter filters (Hot List has them).
- Table: **9 columns** (Candidate, Technology, Status, Pri, Team, Recruiter, Location, Phone, Rating); no row actions, no Quick view, no selection.
- Pager footer. Create dialog: One / Several segmented, 8 fields single-column (one mode); Several = editable 7-column grid + paste box.

## Problems
| # | Problem (evidence) | Category | Severity |
|---|---|---|---|
| 1 | Same state bug as Hot List: filters are component state (useCandidateList.ts:141-148), lost on reload of `/candidates/<id>` or when leaving the screen; not in URL despite App.tsx:291 comment | Efficiency | High |
| 2 | Table overflows at 1440: "Rating" column clipped ("Ratir", `candidates-desktop.png`); at 390 only Candidate/Technology and part of Status are visible (`candidates-mobile.png`) | Responsive | High |
| 3 | Filters inconsistent with Hot List on the same data: no Sort, Priority, Team, Recruiter filters, no Quick view, no saved views (ListControls.tsx:69 gates them on `options`, which CandidatesPage.tsx:44 never passes). A lead cannot find "my team's in-training candidates" without scanning | Efficiency | Medium |
| 4 | 11 always-open filters push the first row to ~y=440 desktop and ~y=690 mobile (`candidates-mobile.png`) | Hierarchy | Medium |
| 5 | Status cell repeats the Hot List double badge ("Active" + "Open to all teams") on a screen whose job is lifecycle status, and "Selected teams" uses the same violet as "Open to all teams" (CandidatesPage.tsx:54, ui.tsx:20-21) | Visual | Low |
| 6 | Create dialog: Team select placeholder "Not yet assigned" sits next to a real option "No team yet" — two near-synonyms with different meaning (CreateCandidateDialog.tsx:19-21; `candidates-create-dialog-desktop.png`); dialog is single column so the submit button is below the fold at 900px; First/Last name could share a row | Cognitive | Medium |
| 7 | Phone column shows full numbers for in-scope rows; useful, but at 9 columns it is what forces Rating off-screen (#2); Rating is mostly "—" | Hierarchy | Low |
| 8 | Success message for bulk create is a bare `livemsg` paragraph above filters (CandidatesPage.tsx:43) — easy to miss, no link to the new rows | Cognitive | Low |

## Recommended redesign
### Desktop
- Share the Hot List `FilterBar`: primary row Search · Technology · Status · Batch · Location + "More filters (n)" (Visibility, Visa, Documents, Resume, Stay, and — if the API accepts them on `/candidates`, else leave out — Priority/Team/Recruiter) + Sort. Chips for active filters. **API: verify `salesApi.candidates` accepts priority/team/recruiter/sort before adding; otherwise UI-only subset.**
- Table to 7 columns: Candidate (+technology 2nd line) · Status (single badge; visibility as small text) · Pri · Team · Recruiter · Location · Batch/Rating merged as "Rating" only when set. Add Quick view icon (reuse Hot List drawer).
- URL query state via shared `useUrlListState`.
- Create dialog: two-column grid for First/Last name and Phone/Email; Team placeholder "Choose a team…" and keep "No team yet (assign later)" as the explicit option; sticky DialogActions footer.
### Mobile
- Same bottom-sheet filters and card rows as Hot List (name+pri / status+tech / team+location).
- Header buttons: keep New candidate primary; New batch into an overflow "⋯" menu to save a row.
### Reusable components
Existing: `ListFilters` → refactor into shared `FilterBar`; `Drawer` quick view from HotListPage.tsx:135-163 (extract `CandidateQuickView`); `Dialog`. New: `useUrlListState`, `CandidateQuickView`, card-mode table CSS.

## Before/after interaction comparison
| Task | Before | After |
|---|---|---|
| Find an in-training candidate in my team | Status=In training, then scan the Team column (no team filter) | Status + Team filter, 2 picks |
| Check rating of a row (1440) | horizontal scroll | visible |
| Open profile, reload, back | filters lost | restored |
| Create one candidate | 8 fields in a scrolling dialog, scroll to submit | 8 fields in 5 rows, submit visible |

## Expected benefit
One mental model for both candidate lists; no hidden columns on desktop; filters survive reloads.

## Implementation complexity: M
CandidatesPage.tsx, ListControls.tsx, useCandidateList.ts, CreateCandidateDialog.tsx, styles.css; shared with Hot List work. No API change if extra filters are limited to what `/candidates` already supports (to verify in `salesApi.ts`).

## Scorecard
| Dimension | Score | Evidence |
|---|---|---|
| Usability | 6 | Works; High #1 |
| Visual hierarchy | 6 | #4, #5 |
| Efficiency | 5 | #1, #3 |
| Responsiveness | 4 | #2: 2 columns visible at 390; no page overflow |
| Accessibility | 7 | Labelled filters, live count, Name buttons with aria-label; 17px-tall name buttons (spacing exception) |
| Design consistency | 5 | Diverges from Hot List on filters/quick view/sort; `.pagehead` used correctly here |

## Validation
Visual inspection: desktop 1440 (ceo, r1a) and mobile 390 screenshots; create dialog opened as ceo; touch targets measured at 390 (name buttons 17px high, no overflow). Redesign validation: pending (not implemented).

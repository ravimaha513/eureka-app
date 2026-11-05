# Paperwork & BGC (queue + templates) — `/paperwork`
Status: Audited · Redesign proposed · Implemented (rebrand wave 2)
Who / permission: `document:read` or `bgc:update` (nav.ts:25) — HR, Accounts, Immigration, CEO/org-wide; Templates tab only when `templates` query succeeds (org-wide roles)
Source: `apps/web/src/paperwork/PaperworkPage.tsx`, `paperwork/ui.tsx`, `ui/Pager.tsx`
Evidence: `paperwork-desktop.png`, `paperwork-mobile.png`, `paperwork-desktop-full.png`, `paperwork-mobile-full.png`, `paperwork-hr-desktop.png`, `paperwork-focus-desktop.png`

## Primary objective
An HR, Accounts or Immigration user sees which placements have overdue or required paperwork and opens the most urgent one.

## What's on screen
- Header: h1 and a one-line sub.
- Section tabs: Work queue / Templates (`role=tablist`, :46-49).
- Filters: "Show" toggle chips (Outstanding/Overdue/All, :81-87), 4 selects (Owner role, BGC status, Placement status, Placement type), 1 checkbox ("Assigned to me"), and a conditional "Clear filters" button.
- Table: 6 columns (Candidate, Placement, Checklist, Next due, BGC, Open), 50 rows per page, cursor pager.
- Templates tab: 2 cards (Paperwork, Onboarding), each a 3-row mini table with a "New version" button; the dialog has repeatable rows (doc type text, owner role select, Required checkbox, Remove).

## Problems
| # | Problem (evidence) | Category | Severity |
|---|---|---|---|
| 1 | The section tabs (Work queue/Templates) and the "Show" filter chips use the same pill style: `.tab[aria-selected]` (styles.css:183) and `.tab[aria-pressed]` (styles.css:121) are identical. In `paperwork-desktop.png` there are two rows of identical lavender pills, so navigation reads the same as filtering. | Hierarchy | High |
| 2 | Urgency isn't sortable or scannable. Overdue is a small badge stacked as the third line of the Checklist cell (:159-163). The "Next due" date (:164) is plain text even when it's in the past (every row shows "Nov 2, 2026" + "1 overdue"). There's no sort and no severity order, so the most urgent row can't be found without reading every cell. | Efficiency | High |
| 3 | At 390px the table scrolls inside its card (662px in 360px). Next due, BGC and Open are off-screen (`paperwork-mobile.png`), so the BGC status, one of the two things the page is named after, is invisible on a phone. | Responsive | High |
| 4 | The queue tablist (:46) has `role=tab` but no `aria-controls`, no `role=tabpanel` and no arrow-key handling, unlike the workspace tabs (PaperworkWorkspace.tsx:91-99). Screen readers announce tabs that don't behave like tabs. | A11y | Medium |
| 5 | Each row has two targets that do the same thing: the name link (:151) and an "Open" button (:166). The Open column takes about 90px on desktop and adds 50 tab stops per page. | Efficiency | Low |
| 6 | The table is wrapped in tablewrap twice: `.card.tablewrap` > `.tablewrap` (:123, :127). That's two scroll containers, and the measured inner wrap carries the scroll on mobile. | Visual | Low |
| 7 | "Placement status" lists every pipeline status in a native select. The Placement cell repeats type, client and start date on a second muted line, which wraps to 4 lines per row at 390px. | Cognitive | Low |
| 8 | The Templates dialog asks users to type raw snake_case keys ("Document types are snake_case keys", :235) instead of choosing from `docTypeLabel` types. It's an admin-only flow, but it's error-prone. | Cognitive | Medium |
| 9 | The "Assigned to me" checkbox is 13×13px (measured), which fails the WCAG 2.2 2.5.8 target size (24px) unless the label counts as part of the target. The label is clickable, so this is a Low practical risk. | A11y | Low |

## Recommended redesign
### Desktop
- Make the section tabs an underline tablist (new `.tabs.underline`, or reuse the `.tabs.seg` segmented variant at styles.css:1102) placed above the h1 sub. Keep pills only for filter chips.
- Put counts on the view chips: "Outstanding 42 · Overdue 8 · All". Default sort is overdue count, then next due ascending.
- Columns: Candidate (name + recruiter) | Client · type | Checklist (progress bar "0/2", with a red "1 overdue" chip next to it, not under it) | Next due (red, with "3d overdue", when in the past) | BGC badge. Drop the Open column; the whole row is a link (keep `a.rowlink`).
- Collapse the 4 selects into one "Filters" disclosure, so only "Assigned to me" and the view chips stay visible. Show active filter chips with an × each.
### Mobile
- Under 640px, render each row as a card: name + BGC badge on line 1, client · type on line 2, then "0/2 done · 1 overdue · due Nov 2". The whole card is the link. No horizontal table.
- The filters disclosure becomes a bottom sheet.
### Reusable components
- Existing: `StatusChips`/`.tabs.wrap` for the chips, `BgcBadge`, `PipelineStatus`, `Pager`.
- New shared: `DueDate` (formats the date and marks it red with "Nd overdue" when in the past; also used by the Payments Expected column, the Bills Due date and Employees Planned end), `ResponsiveTable` (cards under 640px from a column spec), `.tabs.underline` for real section tabs.

## Before/after interaction comparison
| Task | Before | After |
|---|---|---|
| Find the most overdue placement | Scan every row's Checklist cell; no sort (≈ read 50 cells) | First row after the default sort (0 extra actions) |
| See BGC status on a phone | Swipe the table sideways per row | Visible on the card (0 swipes) |
| Tell tabs from filters | Visual guess | Distinct underline vs pill |

## Expected benefit
Triage time drops from scanning to reading the top rows, and the BGC column becomes usable on mobile. Fewer mis-clicks between the section tabs and the filters.

## Implementation complexity: M
PaperworkPage.tsx plus styles.css (new underline tab and responsive card CSS). Sort by overdue needs the API to accept `sort=overdue` or to return items pre-sorted. If it can't, sort client-side within the page (partial). Counts on the chips need a count endpoint, or drop that part.

## Scorecard
| Dimension | Score | Evidence |
|---|---|---|
| Usability | 6 | Works, but urgency is buried (#2) |
| Visual hierarchy | 5 | Two identical pill rows (#1); overdue is the 3rd line of a cell |
| Efficiency | 5 | No sort; duplicate Open (#2, #5) |
| Responsiveness | 4 | BGC and Next due off-screen at 390 (#3) |
| Accessibility | 6 | Tabs semantics incomplete (#4); otherwise labelled selects, live count |
| Design consistency | 6 | Same chip/tab style for two meanings; matches other list pages otherwise |

## Validation
Visual inspection: desktop 1440 and mobile 390 as ceo and hr (`paperwork-*.png` listed above). Overflow measured: page 390/390 (no page overflow), table wrap 662/360. Redesign validation: pending (not implemented).

### Implemented (wave 2)
| Audit item | Change | Evidence (`screenshots/after/`) |
|---|---|---|
| #1 Tabs and filter chips look alike (High) | Sections use `ui/Tabs` (underline, `?section=`); Show is a segmented `aria-pressed` toggle group in the FilterBar | paperwork-desktop.png |
| #2 Urgency not sortable (High) | Overdue is its own right-aligned column (red chip); Next due flags "Nd overdue"; Sort: Most overdue first (default) / Next due / Queue order, in the URL; sorted within the loaded page (no API sort exists) | paperwork-desktop.png |
| #3 BGC off-screen at 390 (High) | `.dtable` cards: name + BGC chip on line 1, then checklist bar, overdue, next due, placement | paperwork-mobile.png |
| #4 Tab semantics (Medium) | `ui/Tabs`: tablist/tab/tabpanel, roving tabindex, arrows/Home/End | unit tests |
| #5 Duplicate Open (Low) | Open column dropped; the name (RecordLink) and the row open the placement | paperwork-desktop.png |
| #6 Double tablewrap (Low) | One `.card.tablewrap.listcard` | — |
| #7 Placement line wraps (Low) | Client · type is its own p2 column; Starts is p3 | paperwork-desktop.png |
| Filters in URL | view, role, mine, bgc, pstatus, ptype, sort via `useSearchParams`; Placement status/type behind More filters as chips; phone filter sheet | unit test |

Not changed / deferred: #8 Template doc types as snake_case keys (Medium): not changed; needs a doc-type catalogue (product decision). #9 Checkbox target: label is the target; 44px row height on phones.

Validation (wave 2): typecheck clean; unit tests for paperwork, employees, payments, sites and datahub pass (87). The shared API on :3000 and its Postgres were down during this wave (the session could not restart them), so the visual check ran against the built screens with the network layer mocked by fictional fixtures (Playwright `page.route`), at 1440×900 and 390×844, light and dark. Page width at 390 is 390 on every screen and state; no table wrap scrolls sideways at either width; every row action column (`td.c-act`) is inside the viewport at 1440. Re-check against live seeded data when the API is back.

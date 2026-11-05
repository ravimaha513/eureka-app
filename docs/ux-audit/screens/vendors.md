# Preferred vendors — `/vendors`
Status: Audited · Redesign proposed (minor)
Who / permission: `vendor.preferred:create` or `vendor.preferred:read` (nav.ts:41) — recruiters (own entries) and their superiors (lead, manager, AD, CEO).
Source: `apps/web/src/pipelinereport/PreferredVendorsPage.tsx`, `pipelinereport/pipelineReportApi.ts`, `ui/Dialog.tsx`, `sales/ui.tsx` (Field)
Evidence: `vendors-desktop.png`, `vendors-desktop-full.png`, `vendors-mobile.png`, `vendors-mobile-full.png`, new: `vendors-recruiter-desktop.png`, `vendors-recruiter-mobile.png`
Note: no seeded user has preferred vendors, so only the empty state was seen live; the populated table is audited from code. I did not add data (audit only).

## Primary objective
Recruiter keeps a personal list of vendors (contact, technology, clients) to reuse when submitting; superiors see their team's lists.

## What's on screen
`.pagehead` h1 + subtitle + **Add vendor** (primary); filter toolbar: Search (vendor/contact/client), Recruiter select (only if > 1 owner), Archived checkbox; table **6 columns** (Vendor+notes, Contact+email+phone, Technology, Clients, Added by, actions Edit / Archive); empty state "No preferred vendors yet."; Add/Edit dialog (wide) with 8 fields; Archive confirm.

## Problems
| # | Problem (evidence) | Category | Severity |
|---|---|---|---|
| 1 | Preferred vendors are not offered where they are used: Log submission's Vendor picker shows "No vendors yet" (lookup vendors) even when the recruiter keeps a preferred list (`candidate-profile-logsubmission-desktop.png`, LogSubmissionDialog.tsx:114). The screen is a dead-end list | Efficiency | Medium |
| 2 | Empty state has no action ("No preferred vendors yet.", PreferredVendorsPage.tsx:79); the Add vendor button is far away in the header and on desktop not right-aligned — it floats after the subtitle because the button is not wrapped in `.push` (PreferredVendorsPage.tsx:34 vs CandidatesPage.tsx:34; `vendors-desktop.png`) | Hierarchy | Low |
| 3 | Edit (secondary) and Archive (danger) sit side by side in every row (PreferredVendorsPage.tsx:74-75); with many rows the red buttons dominate the table | Visual | Low |
| 4 | Search fires a query per keystroke (no debounce, PreferredVendorsPage.tsx:22-23) unlike candidate lists (250ms, useCandidateList.ts:152-158) | Efficiency | Low |
| 5 | No pagination or count; long notes render as full block text under the vendor name, making rows tall (:66) | Cognitive | Low |
| 6 | Archived is a checkbox (13×13px, measured at 390) that switches the whole list to a different data set — reads as a filter but behaves as a mode; empty message changes to "No archived vendors." | A11y / Cognitive | Low |
| 7 | Mobile: 6-column table will scroll horizontally once populated (`.tablewrap`, same pattern as hotlist.md #9); currently only the empty state is visible | Responsive | Medium (code-based) |

## Recommended redesign
### Desktop
- Wrap Add vendor in `<div className="rowactions push">` like Candidates. Empty state gets its own "Add your first vendor" button.
- Filter bar: Search (debounced 250ms) · Recruiter · segmented "Active | Archived" (replaces checkbox).
- Table: Vendor (+ technology tag) · Contact (name, email link, phone) · Clients · Added by · actions as an icon "⋯" menu (Edit, Archive…). Notes truncated to one line with `title`.
- In Log submission's Vendor picker, list the user's preferred vendors first in an optgroup "Your preferred vendors" — **needs the dialog to call `pvApi.vendors` (existing endpoint); vendor ids map via `vendorId`; no new API.**
### Mobile
Card rows: vendor name + technology; contact line (tap-to-mail / tap-to-call); "⋯" menu. Archived segmented control 44px.
### Reusable components
Existing: `Dialog`, `ConfirmDialog`, `Field`, `.pagehead/.push`, `QueryError`, `Loading`. New/shared: `ActionMenu` (also proposed in candidate-profile.md), segmented control (pattern exists as `.tabs` in CreateCandidateDialog One/Several).

## Before/after interaction comparison
| Task | Before | After |
|---|---|---|
| Use a preferred vendor while logging a submission | leave profile → Vendors → read name → back → pick/create in lookup | pick from "Your preferred vendors" group in the dialog |
| Add first vendor from empty state | move to header button | button in the empty state |
| See archived | tick 13px checkbox | tap "Archived" segment |

## Expected benefit
Makes the list useful at the moment of submission (the recruiter's core task) and aligns the screen with other list screens.

## Implementation complexity: S (M with the Log submission integration)
PreferredVendorsPage.tsx, styles.css; LogSubmissionDialog.tsx for #1. No new API.

## Scorecard
| Dimension | Score | Evidence |
|---|---|---|
| Usability | 7 | #1 Medium, rest Low |
| Visual hierarchy | 7 | #2, #3 |
| Efficiency | 6 | #1, #4 |
| Responsiveness | 6 | #7 (code-based); empty state fine at 390 |
| Accessibility | 7 | Labelled fields, aria-labels per row action, live message; #6 |
| Design consistency | 7 | #2 header alignment, #4 debounce differs |

## Validation
Visual inspection: desktop 1440 (ceo, r1a) and mobile 390 (r1a), empty state only (no seeded vendors); populated table assessed from code. Redesign validation: pending (not implemented).

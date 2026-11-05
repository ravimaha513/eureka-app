# Candidate profile — `/candidates/<id>`, `/hotlist/<id>`
Status: Audited · Redesign proposed
Who / permission: anyone with `candidate:read` on a row with `canOpenProfile !== false` (HotListPage.tsx:23). Actions per server hints / caps: Change status & Edit (`candidate:update`), Log submission (`submission:create`), Delete (`candidate:delete`), Assign team, visibility/rating. Tabs: Submissions (`submission:read`), Documents (`document:read`/`visa:read`/compliance fields), Training (`training:read`), Overview & Activity always.
Source: `apps/web/src/sales/CandidateProfile.tsx`, `CandidateMetrics.tsx`, `EditProfileDialog.tsx`, `LogSubmissionDialog.tsx`, `CandidateResumes.tsx`, `CandidateTimeline.tsx`, `pipeline/CandidateSubmissions.tsx`, `documents/DocumentsSection.tsx`, `training/CandidateTraining.tsx`, `workauth/CandidateWorkAuthorization.tsx`, `App.tsx:294-320,463-467`
Evidence: `candidates-detail-desktop(-full).png`, `candidates-detail-mobile(-full).png`, `hotlist-detail-desktop(-full).png`, `hotlist-detail-mobile(-full).png`, new: `hotlist-detail-recruiter-desktop.png`, `candidate-profile-logsubmission-desktop.png`, `candidate-profile-logsubmission-mobile.png`, `candidate-profile-tab-submissions-desktop.png`, `candidate-profile-tab-documents-desktop.png`

## Primary objective
Recruiter: confirm the candidate is marketable (status, tech, location, visa, resume, phone) and **log a submission**; lead/manager: change status, edit, assign, share. Then return to the list.

## What's on screen
- "← Back to Hot List/Candidates" (btn sm), h1 name, sub-line (status badge, visibility badge, priority, tech, team).
- Header actions (ceo): Edit profile · **Log submission (primary)** · **Delete… (danger) adjacent** (CandidateProfile.tsx:191-193); + Change status ▾ / Assign team / Add to Hot List when allowed. r1a sees only Log submission.
- Tabs (5): Overview, Submissions, Documents, Training, Activity — real ARIA tablist with arrow keys (CandidateProfile.tsx:201-215).
- Overview: Metrics card (**7 tiles**: Submissions, Interviews, Cleared, Not cleared, Selected, Rejected, Placements; wraps 6+1 at 1440) + 3 rate facts; Details card (up to 23 facts, blanks folded under "Not recorded (n)"); side card Sharing and rating; NonResponseCard.
- Submissions tab: 8 funnel tiles + 9 status chips + 2 filters + table + pager.
- Log submission dialog: Job (optional), Job title, Client, Vendor, Rate per hour (5 fields).

## Problems
| # | Problem (evidence) | Category | Severity |
|---|---|---|---|
| 1 | **Delete… sits directly beside the primary Log submission** in the header (CandidateProfile.tsx:192-193; `candidates-detail-desktop-full.png`, `candidates-detail-mobile.png` where the three are one row at 390). A destructive, rare action has equal prominence to the most frequent one | Hierarchy | High |
| 2 | Overview leads with 7 metric tiles that wrap 6+1 (orphan "Placements" tile, `candidates-detail-desktop-full.png`; `.cp-metrics .tiles` minmax 170px, styles.css:366). For new candidates all are "0 / None yet". The facts a recruiter needs before submitting (location, visa, phone, resume) are below the fold: Details heading at **y=1240 on 390px** (measured), ~y=680 desktop | Hierarchy | High |
| 3 | Submissions tab repeats metrics again: 8 zero tiles + 9 zero-count chips + filters above an empty table (`candidate-profile-tab-submissions-desktop.png`); "Submissions 0" (Overview) and "Submitted 0" (tab) are the same number with different labels | Cognitive | Medium |
| 4 | Tab is component state (CandidateProfile.tsx:51), not in the URL: reload or a shared link always lands on Overview; after logging a submission the user stays on Overview and must switch tabs to see it | Efficiency | Medium |
| 5 | Header sub-line repeats the list's triple status encoding: status badge + "Active/All Teams" text + "Open to all teams" badge (CandidateProfile.tsx:170-175), and Visibility is shown again in Details (:143) and in Sharing card | Visual | Low |
| 6 | "Log submission" is offered for a **Terminated** candidate (`candidates-detail-desktop-full.png`, Cand144 Terminated); `canSubmit` ignores status (CandidateProfile.tsx:97). If the server rejects, the user learns only after filling 5 fields; if it allows, the UI should at least warn | Cognitive | Medium (verify API) |
| 7 | Log submission dialog: Rate per hour has no unit/currency and no hint (LogSubmissionDialog.tsx:115-117); Vendor shows "No vendors yet" even when the user keeps Preferred Vendors (separate list, `candidate-profile-logsubmission-desktop.png`) | Cognitive | Low |
| 8 | Mobile: tabs wrap to 2 rows of pills (`candidates-detail-mobile.png`), action buttons wrap; 7 tiles stack full-width ~100px each (≈700px of zeros) | Responsive | Medium |
| 9 | Back button is `btn sm` 30px tall (styles.css:209) — the main way back to the list on mobile is below 44px; mobile header actions all < 44px (measured 8/8 targets < 44) | A11y | Low |
| 10 | Documents tab for a recruiter shows a single half-width card with four "—" (`candidate-profile-tab-documents-desktop.png`); no resume block (requires `document:read`), so the tab is mostly empty for the primary role | Hierarchy | Low |

## Recommended redesign
### Desktop
- **Header**: Back link · name · one status line (status badge, priority, tech, team, location; visibility as a small "All teams" tag only). Right: **Log submission (primary)**, Change status ▾, Edit profile, and an overflow **"⋯" menu** holding Assign team, Delete… (danger, last item, separated).
- **Overview layout**: Details card first (left 2/3), with a "Key facts" strip at the top: Location · Visa · Stay · In-person · Phone · Resume on file · Days in market. Metrics move to the right column as a **compact 2×2 summary** (Submissions, Interviews, Selected, Placements; Cleared/Not cleared/Rejected as text below) — and collapse to one line "No submissions yet — Log submission" when all zero.
- **Tab in URL** (`/hotlist/<id>?tab=submissions`), and after a successful Log submission switch to the Submissions tab with the new row highlighted (the dialog already has a "Submission logged" done step, LogSubmissionDialog.tsx:90).
- Submissions tab: hide funnel tiles and zero-count chips when total = 0; show the empty state with an inline "Log submission" button.
- Log submission dialog: Rate field with "$ / hr" adornment; if status is terminated/stopped, show a warning note above fields (or hide the action if the API forbids).
### Mobile
- Sticky bottom action bar: Log submission (primary, full width) + "⋯" (status/edit/assign/delete).
- Tabs as a single horizontally scrollable row (no wrap).
- Key facts strip first; metrics as a 2×2 grid; Back as 44px-high link in the top bar.
### Reusable components
Existing: `Dialog`, `ConfirmDialog`, StatusMenu popover pattern (CandidateProfile.tsx:458-499) → generalise into `ActionMenu` (also used for the "⋯" menu); `.tiles`, `.facts`. New: `KeyFacts` strip, `ActionMenu`, `useUrlTab`.

## Before/after interaction comparison
| Task | Before | After |
|---|---|---|
| Check visa/location/phone before submitting (390px) | scroll ~1240px past 7 tiles | visible in key-facts strip on load |
| Log a submission and verify it | Log submission → fill → done → close → click Submissions tab | Log submission → fill → lands on Submissions with row highlighted |
| Delete by mistake risk | Delete one tab-stop from primary | inside ⋯ menu, then confirm |
| Reload on Submissions tab | back on Overview | stays on Submissions |

## Expected benefit
Faster submission flow for recruiters (the revenue action), lower risk of accidental deletion, less empty-metric noise for new candidates.

## Implementation complexity: M
CandidateProfile.tsx, CandidateMetrics.tsx, CandidateSubmissions.tsx, LogSubmissionDialog.tsx, styles.css (`.cp-*`). No API changes (verify submit rules for terminated status in `apps/api/src/modules/submissions` before choosing hide vs warn).

## Scorecard
| Dimension | Score | Evidence |
|---|---|---|
| Usability | 6 | Works end-to-end; #1, #2 High |
| Visual hierarchy | 5 | #1, #2, #5 |
| Efficiency | 6 | #2, #4 |
| Responsiveness | 5 | #8, Details at y=1240; no overflow |
| Accessibility | 7 | Proper tablist, live messages, focus returns to opener on Back (App.tsx:303-310); #9 small targets |
| Design consistency | 6 | Metrics appear in two tile styles across tabs; StatusMenu good pattern not reused for other actions |

## Validation
Visual inspection: desktop 1440 and mobile 390 (ceo and r1a); opened Log submission dialog, Submissions and Documents tabs; measured mobile Details offset and targets; verified Back keeps list filters and focus. Redesign validation: pending (not implemented).

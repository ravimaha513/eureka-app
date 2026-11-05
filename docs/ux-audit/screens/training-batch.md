# Training batch detail — `/training/<id>`
Status: Audited · Redesign proposed · Implemented (rebrand wave 2)
Who / permission: `training:read`; actions from `batch.actions` (manage, addStudents, updateProgress, delete) and import capability
Source: `apps/web/src/training/BatchDetail.tsx`, `training/BulkCandidatesDialog.tsx`, `training/ui.tsx` (ProgressBar)
Evidence: `training-detail-desktop.png`, `training-detail-desktop-full.png`, `training-detail-mobile.png`, `training-detail-mobile-full.png`, new: `training-detail-student-expanded-desktop-full.png`, `training-detail-courses-desktop.png`, `training-detail-bulk-dialog-desktop.png`, `training-detail-addstudents-desktop.png`

## Primary objective
The trainer or location ops sees each student's progress and ticks off completed modules. Secondary: manage the batch's courses and students.

## What's on screen
Breadcrumb; header card (cover 220×128, name, status, meta, 4 stats, status/edit/delete buttons when allowed). 2 tabs "View Courses"/"View Students". Students panel: search, "Upload new candidates", "Add students", accordion per student (name, tech, hours, progress bar, %, open profile, remove). Expanded: per course a progress bar plus module checkboxes with "Completed <date> by <name>".

## Problems
| # | Problem (evidence) | Category | Severity |
|---|---|---|---|
| 1 | Header card: the cover placeholder takes 220×128px saying "Training batch" (`training-detail-desktop.png`), and on mobile the cover plus stats push the student list to y≈580 (`training-detail-mobile-full.png`). | Hierarchy | Medium |
| 2 | Tab labels are verbs ("View Courses", "View Students", BatchDetail.tsx:83-85) with `&nbsp;` spacing hacks, and there's no arrow-key handling or roving tabindex on `role="tab"`. | A11y / Copy | Medium |
| 3 | Students are listed in API order with no sort by progress, so you can't see "who is behind" without reading every %. The bar has no reference to the batch's elapsed time. | Efficiency | Medium |
| 4 | Expanded student: read-only checkboxes are disabled and pale grey (`training-detail-student-expanded-desktop-full.png`), and "Completed Nov 5, 2026 by coach" is 12px muted text inline after the label. For non-editors, 15 disabled checkboxes read as "unavailable", not "done/not done". | Visual / A11y | Medium |
| 5 | A course with 0 modules ("Git Concepts", 0%) still shows a progress bar and counts toward courses, so a student can never reach 100% (`training-detail-student-expanded-desktop-full.png`). Nothing warns about it. | Cognitive | Medium |
| 6 | Toolbar: the "Search students" label sits above its input while the two buttons sit below the label baseline, so things are misaligned (`training-detail-desktop.png`). "Upload new candidates" vs "Add students" (L276-278) is a subtle split (new people vs existing people) shown as two peer buttons. | Visual / Cognitive | Low |
| 7 | Per-row actions are unlabelled icons (external-link, user-minus), and "Remove" sits next to "Open" with no separation (L299-305). On mobile they wrap to their own row (`training-detail-mobile-full.png`). | Efficiency | Low |
| 8 | Bulk dialog: native unstyled file input ("Choose File No file chosen") inside a styled bordered box (`training-detail-bulk-dialog-desktop.png`, BulkCandidatesDialog.tsx:112-113). The primary "Create candidates" is disabled with no reason given. | Visual | Low |

## Recommended redesign
### Desktop
- Header: drop the large cover (40px chip), one line of meta, stats as an inline row. Status/edit actions on the right.
- Tabs: "Students (4)" / "Courses (4)", using the shared `useTablist`.
- Students: sort select (Name / Progress ↑) plus a "behind" chip when progress < elapsed-time %, both computed client-side from startDate/endDate, which are already loaded. Row: whole row toggles expand. Actions in an overflow menu (Open profile, Remove from batch).
- Expanded read-only view for non-editors: ✓ / ○ icons instead of disabled checkboxes, completion date in its own column.
- Mark 0-module courses "No modules yet" and leave them out of the student % (client-side only if the API % already excludes them; otherwise flag only).
- Toolbar: one "Add students ▾" menu → "From existing candidates" / "Upload new (Excel)".
### Mobile
Header ≤ 140px, with the student list visible above the fold. Progress row: name + % on one line, bar below, actions in an overflow menu.
### Reusable components
Existing: `ProgressBar` (role=progressbar, good), Dialog. New: shared `useTablist`, `<OverflowMenu>` (also needed in Access users, see access.md).

## Before/after interaction comparison
| Task | Before | After |
|---|---|---|
| Find students who are behind | Read every % | Sort by progress / "behind" chip |
| Add students | Choose between two peer buttons | One menu with explained options |
| Mobile: reach first student | Scroll ~580px | Visible on load |

## Expected benefit
Faster triage of struggling students, a clearer read-only state, less chrome.

## Implementation complexity: M
BatchDetail.tsx, ui.tsx, styles. No API change (sorting/behind computed client-side).

## Scorecard
| Dimension | Score | Evidence |
|---|---|---|
| Usability | 6 | Core tick-off works; read-only ambiguous (#4) |
| Visual hierarchy | 6 | Header heavy (#1) |
| Efficiency | 5 | No sort, two add buttons (#3, #6) |
| Responsiveness | 6 | No overflow; list pushed down (#1) |
| Accessibility | 6 | progressbar roles good; tablist keyboard missing (#2) |
| Design consistency | 6 | Tab copy/icons differ from other tabs (#2) |

## Validation
Visual inspection: CEO (read-only) at 1440 and 390, student expanded, Courses tab, bulk dialog, add-students dialog. Editor view (locD) not separately captured. Redesign validation: pending (not implemented).

### Implemented (wave 2)
| Audit item | Change | Evidence |
|---|---|---|
| #1 Heavy header (Medium) | No 220px cover: 40px chip, h1 + status, one meta line, figures in one row (Students, Courses, Dates, Schedule, Batch year). Next status action is the primary button, Edit beside it, Cancel batch / Delete batch in a More menu (danger). Phone: student list starts at y≈470 (was ≈580+). | `after/training-batch-desktop.png`, `after/training-batch-mobile.png` |
| #2 Verb tabs, no keyboard model (Medium) | Kit `Tabs` "Students n" / "Courses n" (arrow keys, roving tabindex). Default tab rule unchanged. | `after/training-batch-desktop.png` |
| #3 No sort / "who is behind" (Medium) | Sort: Name / Progress lowest / highest. While in training, "42% of the batch calendar has passed; **2 behind**" and a "Behind" chip on students more than 10 points under the elapsed share (client-side). | `after/training-batch-desktop.png` |
| #4 Disabled grey checkboxes for read-only users (Medium) | Read-only users see a ✓ (ok colour) or ○ mark with "Done:/Not done:" for screen readers; completion date in its own right-aligned column. Editors keep the checkboxes (20px, 40px rows on phones). | `after/training-batch-readonly-desktop-dark.png` |
| #5 0-module course counts silently (Medium) | "No modules" chip in the course list, "No modules yet" instead of a 0% bar in each student's course, and a line explaining nobody can complete it. The API percentage is untouched (flag only). | — |
| #6 Toolbar misaligned (Low) | Search, Sort and the add buttons share one baseline row. The two add buttons stay separate (different flows). | — |
| #7 Unlabelled row icons (Low) | Not changed. | — |
| #8 Bulk dialog file input (Low) | Not changed. | — |

Validation (wave 2, 2026-11-05): `pnpm --filter @eureka/web typecheck` clean; full web unit suite 552/552 (admin, staff, training, team suites updated only where markup/interaction changed). Visual check at 1440×900 and 390×844, light and dark, in Playwright against a fixture API built from the `*Api.ts` shapes, because the shared API on :3000 and its Postgres were not running in this environment. Page width at 390 = 390 on every screen below; row actions visible at 1440. Live-data re-check against the seeded API is still owed.

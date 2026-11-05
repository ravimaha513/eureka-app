# Staff birthdays — `/birthdays`
Status: Audited · Redesign proposed · Implemented (rebrand wave 2)
Who / permission: `staff.birthday:manage` (nav.ts:48) — HR
Source: `apps/web/src/staff/BirthdaysPage.tsx`, `staff/BirthdayFields.tsx`
Evidence: `birthdays-desktop.png`, `birthdays-desktop-full.png`, `birthdays-mobile.png`, `birthdays-mobile-full.png`, new: `birthdays-editing-desktop.png`, `birthdays-mobile-scrolled.png`

## Primary objective
HR fills in missing staff birthdays (month/day) so the CEO's 08:00 digest is complete.

## What's on screen
Intro, a filter input, an "Only without a birthday" checkbox, a count hint ("0 of 21 staff have a birthday on file"), a table of 21 rows (Name+designation/email, Roles, Location, Birthday, Set/Change). Inline edit turns into month/day fields + Save/Clear/Cancel.

## Problems
| # | Problem (evidence) | Category | Severity |
|---|---|---|---|
| 1 | Mobile: the Birthday column and the **Set** button are off-screen to the right. The table is 5 columns in horizontal scroll (`birthdays-mobile.png`, `birthdays-mobile-scrolled.png`), so you can't do the one task without sideways scrolling. | Responsive | High |
| 2 | Filling 21 missing birthdays is 21 × (Set → month → day → Save) = ~84 interactions. After Save, focus isn't moved to the next row, and with "Only without a birthday" on, the saved row vanishes and focus is lost (BirthdaysPage.tsx:19, L55). | Efficiency / A11y | Medium |
| 3 | The completeness hint is 12px muted text at the end of the toolbar (L30, `birthdays-desktop.png`), yet it's the screen's KPI. "Only without a birthday" isn't on by default although 0/21 are set. | Hierarchy | Medium |
| 4 | The secondary line under the name is designation **or** email (L61), so rows mix "Systems Administrator" and "acct@eureka.example" (`birthdays-desktop.png`). | Consistency | Low |
| 5 | There's no "upcoming birthdays" ordering or column. HR can't check who's in tomorrow's digest. The list is in API order. | Efficiency | Low |
| 6 | The checkbox is a 13×13 native input (Playwright measurement), with the label as hit area; the filter label is long ("Filter by name, role or location"). | A11y | Low |

## Recommended redesign
### Desktop
- A header stat: "21 staff · **21 missing**" as a prominent progress meter, with a "Show missing only" toggle defaulting to on when any are missing.
- Inline edit: month/day selects always visible in the Birthday cell for missing rows (no Set step), auto-saved on day change, or saved with Enter. After saving, focus the next missing row's month select. Announce through a live region.
- Columns: Name (with designation, falling back to email), Location, Birthday, "Next" (e.g. "in 12 days"), sortable by Next. Roles go into a muted second line.
### Mobile
Card per person: name / role line, birthday fields full-width beneath. No horizontal scroll.
### Reusable components
Existing: `BirthdayFields`. New: `<RowCardList>` (shared with dashboard.md).

## Before/after interaction comparison
| Task | Before | After |
|---|---|---|
| Set 21 birthdays | ~84 actions, focus lost on filtered save | ~42 (month, day), focus auto-advances |
| Set one on mobile | Scroll table sideways, tap Set, fill, Save | Fill fields in the card |

## Expected benefit
Roughly halves data-entry effort, makes the screen usable on a phone, and puts completeness up front.

## Implementation complexity: S
BirthdaysPage.tsx + styles. No API change.

## Scorecard
| Dimension | Score | Evidence |
|---|---|---|
| Usability | 6 | Simple, but repetitive (#2) |
| Visual hierarchy | 6 | KPI hidden (#3) |
| Efficiency | 5 | 4 steps per row (#2) |
| Responsiveness | 4 | Action off-screen at 390 (#1) |
| Accessibility | 6 | Labelled buttons; focus lost after filtered save (#2) |
| Design consistency | 7 | Standard table/toolbar (#4 minor) |

## Validation
Visual inspection: hr at 1440 (normal + editing) and 390 (default + table scrolled). Redesign validation: pending (not implemented).

### Implemented (wave 2)
| Audit item | Change | Evidence |
|---|---|---|
| #1 Mobile: Birthday and Set off-screen (High) | Kit `.dtable` record cards: name, location, birthday, next, action bottom-right (44px). Editing puts month + day side by side at 44px/16px. | `after/birthdays-mobile.png`, `after/birthdays-editing-mobile-dark.png` |
| #2 Focus lost after a filtered save (Medium) | After Save/Clear, focus moves to the next row's Set/Change button (also when the saved row leaves "Only without a birthday"); Set focuses the month select; Escape or Cancel returns focus to Set; result announced in a live region; Enter in the day field saves. | — |
| #3 KPI hidden (Medium) | Completeness strip: "**8** missing", a meter (`role=progressbar`, "6 of 14"), and the count in the h1 box; the toggle shows the missing count. Default of the toggle left off (no silent view change). | `after/birthdays-desktop.png` |
| #4 Mixed secondary line (Low) | Secondary line is always "designation · email". | — |
| #5 No upcoming order (Low) | "Next" column ("Tomorrow", "In 12 days"; bold within a week) and Sort: Name / Next birthday. | `after/birthdays-desktop.png` |
| #6 13px checkbox, long label (Low) | 18px checkbox in a 36px (44px phone) label; filter label "Filter" with a placeholder. | — |

Validation (wave 2, 2026-11-05): `pnpm --filter @eureka/web typecheck` clean; full web unit suite 552/552 (admin, staff, training, team suites updated only where markup/interaction changed). Visual check at 1440×900 and 390×844, light and dark, in Playwright against a fixture API built from the `*Api.ts` shapes, because the shared API on :3000 and its Postgres were not running in this environment. Page width at 390 = 390 on every screen below; row actions visible at 1440. Live-data re-check against the seeded API is still owed.

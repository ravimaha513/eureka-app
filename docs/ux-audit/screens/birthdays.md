# Staff birthdays — `/birthdays`
Status: Audited · Redesign proposed
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

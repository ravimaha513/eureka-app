# Courses — `/courses`
Status: Audited · Redesign proposed
Who / permission: `training:manage` (nav.ts:34) — location ops (locD), training managers
Source: `apps/web/src/training/CoursesPage.tsx`, `training/ui.tsx`
Evidence: `courses-desktop.png`, `courses-desktop-full.png`, `courses-mobile.png`, `courses-mobile-full.png`, new: `courses-drawer-desktop.png`, `courses-drawer-mobile.png`

## Primary objective
Keep the course library current: create a course, add/reorder/edit modules, archive old ones.

## What's on screen
Header with a "Show archived" checkbox and "Add course". A card grid (4 courses): 128px coloured cover with icon + "Course", title, location, Modules/Duration/Batches, Open button. The drawer (Dialog) has meta, Edit course / Archive / Delete, and a Modules list with up/down/edit/delete icon buttons per module plus Add module.

## Problems
| # | Problem (evidence) | Category | Severity |
|---|---|---|---|
| 1 | The cover art takes ~45% of each card and says "Course" on every card (`courses-desktop.png`). With a library of 20+ courses this is mostly scrolling past decoration. | Visual / Efficiency | Medium |
| 2 | An incomplete course isn't flagged: "Git Concepts 0 Modules · 0m · 1 Batches" (`courses-desktop.png`) is assigned to a batch, and it blocks students reaching 100% (see training-batch.md #5). Nothing on the card warns. | Cognitive | Medium |
| 3 | No search and no location filter (CoursesPage.tsx:28-38). Only the "Show archived" checkbox, whose native input is 13×13px (Playwright measurement at 390px; WCAG 2.5.8 needs 24px unless spaced, and the label helps, so Low). | Efficiency / A11y | Low |
| 4 | Pluralisation: "1 Batches" (`courses-desktop.png`). | Copy | Low |
| 5 | Module reorder is up/down buttons only, one API call per step (L175-180). Moving the last module to the top of 7 takes 6 clicks and 6 requests. | Efficiency | Low |
| 6 | Drawer: Delete (danger) sits right next to Edit/Archive at the top (L157-161, `courses-drawer-desktop.png`). It's guarded by a confirm dialog, so this is only Low. | Visual | Low |
| 7 | The card has "Open" as a button while the title is link-coloured but inert, the same affordance problem as the Training cards (L47, L56). | Consistency | Low |

## Recommended redesign
### Desktop
A table/list view by default (Title, Location, Modules, Duration, Used in N batches, status, with the row opening the drawer), plus a search box and location select. Show an "Empty: no modules" warning badge when modules=0. Cards (if kept): drop the cover, use a 40px icon chip. Drawer: Delete moves into a footer/overflow. Optionally add "Move to top/bottom" to the reorder.
### Mobile
List rows (title + meta line) instead of 128px covers. The drawer already goes full-width (`courses-drawer-mobile.png`).
### Reusable components
Existing: Dialog drawer, `CoverArt size="sm"`. New: shared `<OverflowMenu>`.

## Before/after interaction comparison
| Task | Before | After |
|---|---|---|
| Find "Java Core" among 30 courses | Scroll card grid | Type in search |
| Spot courses with no modules | Read each card's "0" | Warning badge |

## Expected benefit
More courses per screen, and gaps in the library are visible.

## Implementation complexity: S
CoursesPage.tsx + styles. No API change.

## Scorecard
| Dimension | Score | Evidence |
|---|---|---|
| Usability | 7 | Clear drawer CRUD |
| Visual hierarchy | 6 | Cover dominates (#1) |
| Efficiency | 6 | No search; reorder by steps (#3, #5) |
| Responsiveness | 7 | No overflow at 390; drawer full-width |
| Accessibility | 7 | Labelled icon buttons; 13px checkbox (#3) |
| Design consistency | 6 | Card affordance (#7), plural (#4) |

## Validation
Visual inspection: locD at 1440 and 390, course drawer opened on both. Redesign validation: pending (not implemented).

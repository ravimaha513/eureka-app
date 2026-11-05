# Training Batches — `/training`
Status: Audited · Redesign proposed
Who / permission: `training:read` (nav.ts:33). Create needs `canCreate` from the API (location ops / training managers)
Source: `apps/web/src/training/TrainingPage.tsx`, `training/ui.tsx` (CoverArt, BatchStatusPill), `styles.css:765-771`
Evidence: `training-desktop.png`, `training-desktop-full.png`, `training-mobile.png`, `training-mobile-full.png`

## Primary objective
Find a batch (usually the current, in-training one at my location) and open it to track student progress.

## What's on screen
Header with a Status select + "Add training batch". A card grid (`tr-grid`), one card per batch: 128px cover placeholder, title, status pill, technology · location, trainer avatar, Students/Courses counts, date range, arrow icon button (the only way to open). Seed: 1 batch.

## Problems
| # | Problem (evidence) | Category | Severity |
|---|---|---|---|
| 1 | Only the small arrow `iconbtn` (icon 18px) opens a batch (TrainingPage.tsx:93-95). The title is styled like a link (`.tr-title { color: var(--pri-700) }`, styles.css:771) but is a plain `h2` (L81), and clicking the card does nothing. Teams cards in Access open on whole-card click (`.cardopen::after`, styles.css:279-280), so the two card patterns behave differently. | Efficiency / Consistency | High |
| 2 | The 128px cover (`.tr-cover.md`, styles.css:767) shows a generic icon and the words "Training batch" on every card (L74). That's ~40% of the card with no information (`training-desktop.png`). | Visual | Medium |
| 3 | The card leaves out progress, which is the reason to open a batch (average completion, students behind), even though the detail view has per-student %. | Efficiency | Medium |
| 4 | There's no search, location or technology filter, only Status (L53-58). Fine for 1 batch; with many locations × technologies it becomes a scroll hunt. | Efficiency | Low |
| 5 | "by coach" with an initial-only avatar next to two count columns (L84-89) reads as a third stat. | Visual | Low |

## Recommended redesign
### Desktop
Compact card or table row: whole card is the link (reuse `.cardopen` pattern), no cover art (or a 40px `tr-cover.sm` chip), title, status, tech · location, trainer, dates, Students, Courses, **avg progress bar** (only if the list API already returns it; otherwise skip — no API change assumed). With more than ~8 batches, offer a table view.
### Mobile
Single-column cards without the cover save ~140px per card. The whole card is tappable.
### Reusable components
Existing: `.cardopen` (TeamsTab), `CoverArt size="sm"`, `BatchStatusPill`. New: none.

## Before/after interaction comparison
| Task | Before | After |
|---|---|---|
| Open a batch | Find and hit the small arrow button (title looks clickable but isn't) | Click anywhere on the card |
| Scan 6 batches | ~2.5 card rows of mostly cover art | One screen |

## Expected benefit
Opening a batch works however the user tries it, and about twice as many batches fit per screen.

## Implementation complexity: S
TrainingPage.tsx + styles (tr-card). No API change.

## Scorecard
| Dimension | Score | Evidence |
|---|---|---|
| Usability | 6 | Misleading title affordance (#1) |
| Visual hierarchy | 6 | Cover dominates (#2) |
| Efficiency | 5 | Small single open target, no progress (#1, #3) |
| Responsiveness | 7 | No overflow at 390 (measured); cards stack |
| Accessibility | 7 | Labelled icon button, status live region; title not operable |
| Design consistency | 5 | Card-open pattern differs from Teams/Courses (#1) |

## Validation
Visual inspection: CEO at 1440 and 390. Redesign validation: pending (not implemented).

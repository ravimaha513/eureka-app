# Coach assignments — `/coaching`
Status: Audited · Redesign proposed (minor)
Who / permission: `coach:assign` (nav.ts:45) — only the `interview_lead` role (packages/shared/src/authz/catalog.ts:811). Audited live as `il@eureka.example` (Interview Lead; not in the brief's user list but seeded).
Source: `apps/web/src/team/CoachingPage.tsx`, `team/Coaches.tsx` (CoachList, AddCoachDialog, shared with Users & Access), `team/coachApi.ts`, styles.css:237-240
Evidence: new: `coaching-desktop.png`, `coaching-desktop-full.png`, `coaching-mobile.png`, `coaching-mobile-full.png`

## Primary objective
Interview Lead assigns each of their coaches to the sales teams they support, and sees at a glance which teams have no coach.

## What's on screen
h1 + subtitle; grid of 3 team cards. Card: team name h2, "Lead l2" text line, "Coaches" h3, coach rows with **Remove** (sm), "No coaches yet." placeholder, **Add coach** (sm). Add dialog = 1 select.

## Problems
| # | Problem (evidence) | Category | Severity |
|---|---|---|---|
| 1 | Heading inversion: the "Coaches" h3 is unstyled (browser default ≈16.4px, muted) and renders **larger than the team-name h2** (15px, styles.css:240) — `coaching-desktop.png`; Coaches.tsx:31 | Visual | Medium |
| 2 | Uncovered teams are not flagged: "No coaches yet." is plain muted text identical to filled cards (Coaches.tsx:39); with many teams the lead must read every card | Hierarchy | Medium |
| 3 | Remove coach acts immediately, no confirm and no undo (Coaches.tsx:21-26), while My team removal goes through a confirm dialog — inconsistent destructive pattern | Consistency | Low |
| 4 | Card layout differs from My team for the same `.team` card: lead as "Lead **l2**" text vs avatar row; Add as secondary here vs primary there (CoachingPage.tsx:134-136 vs MyTeamPage.tsx:40-49) | Consistency | Low |
| 5 | The coach-centric question ("which teams does Karthik cover?") needs reading every card; no per-coach view | Efficiency | Low |
| 6 | Buttons are `btn sm` 30px (all 4 targets < 44px at 390, `coaching-mobile.png`); "Lead"/"Coaches" lines waste vertical space on mobile | A11y / Responsive | Low |
| 7 | Loading/error use plain text, not `Loading` / `QueryError` (CoachingPage.tsx:127-128) | Consistency | Low |

## Recommended redesign
### Desktop
- Same card header as My team: "Team Anjali · Lead l2". Replace the h3 with a small label (`.tilelabel` style) or give `.team h3` 12.5px muted (like `.cp-breakdown h3`, styles.css:371).
- Teams with no coach: warn badge "No coach" in the header and sort them first.
- Optional summary line above the grid: "2 of 3 teams have no coach". Coach chips with × (remove) and an "Undo" in the live message.
### Mobile
Single column already, no overflow. Compact header (team + lead on one line), 44px targets on coarse pointers.
### Reusable components
Share a `TeamCard` header between MyTeamPage and CoachingPage; existing `Loading`, `QueryError`, `.badge` warn variant.

## Before/after interaction comparison
| Task | Before | After |
|---|---|---|
| Find teams without a coach (3 teams) | read 3 cards | warn badges, sorted first |
| Undo an accidental remove | Add coach → pick → submit (3) | Undo in toast (1) |

## Expected benefit
Faster coverage check, fixed heading hierarchy, consistent team-card pattern across admin-ish screens.

## Implementation complexity: S
CoachingPage.tsx, Coaches.tsx (shared with Users & Access — check that screen too), styles.css. No API changes.

## Scorecard
| Dimension | Score | Evidence |
|---|---|---|
| Usability | 7 | #2, #3 |
| Visual hierarchy | 6 | #1 inversion, #2 |
| Efficiency | 7 | #2, #5 |
| Responsiveness | 8 | no overflow at 390; #6 |
| Accessibility | 7 | Labelled buttons naming the team; heading levels present but visually inverted (#1); #6 |
| Design consistency | 6 | #3, #4, #7 |

## Validation
Visual inspection: desktop 1440 + mobile 390 as `il@eureka.example` (seeded Interview Lead); targets/overflow measured. Add/Remove not exercised (would change seed data). Redesign validation: pending (not implemented).

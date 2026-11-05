# My team — `/myteam`
Status: Audited · Redesign proposed (minor) · Implemented (rebrand wave 2)
Who / permission: `team:add_member` (nav.ts:43) — leads (own team), managers / associate directors (every team in their hierarchy).
Source: `apps/web/src/team/MyTeamPage.tsx`, `team/RemoveMemberDialog.tsx`, `team/teamApi.ts`, styles.css:237-240 (`.teamgrid`, `.team`)
Evidence: `myteam-desktop.png`, `myteam-desktop-full.png`, `myteam-mobile.png`, `myteam-mobile-full.png`, new: `myteam-add-dialog-desktop.png`

## Primary objective
A lead sees who is on the team and adds an unassigned recruiter (or removes one).

## What's on screen
h1 + subtitle; live message; grid of team cards (l1: 1 card). Card: team name h2 + "2 members" badge + **Add member** (primary, sm); lead row (avatar, name, "Lead"); member list with **Remove** (sm) per row. Add dialog: 1 select ("Name (email)") + hint + Cancel/Add member. Remove opens a confirm dialog.

## Problems
| # | Problem (evidence) | Category | Severity |
|---|---|---|---|
| 1 | For managers with several teams every card has its own **primary** "Add member" (MyTeamPage.tsx:45-47) — N primary buttons on one page; no page-level primary | Hierarchy | Low |
| 2 | "2 members" badge excludes the lead who is listed right above it (MyTeamPage.tsx:43,49; `myteam-desktop.png`) — count reads as off-by-one | Cognitive | Low |
| 3 | Add / Remove are `btn sm` 30px tall (styles.css:209) — below 44px on touch (`myteam-mobile.png`; measured 3/3 targets < 44px, none < 24px) | A11y | Low |
| 4 | Card fills only ~360px at 1440; the rest of the canvas is empty and the member rows give nothing beyond a name (no link to the member's candidates / Hot List filter), so the lead must go to Hot List and pick Recruiter manually | Efficiency | Low |
| 5 | Add dialog with zero candidates still opens and shows a disabled "No unassigned recruiters" option (MyTeamPage.tsx:93) instead of disabling the button with an explanation | Cognitive | Low |
| 6 | Loading state is plain text "Loading…" (MyTeamPage.tsx:34) not the shared `ui/Loading`; error is not `QueryError` (no retry) — differs from sales screens | Design consistency | Low |

## Recommended redesign
### Desktop
- Card header: "Team Rohit · Lead l1" on one line, member count "3 people (lead + 2)"; Add member as a secondary `btn sm` with icon; if only one team, a single primary "Add member" in `.pagehead`.
- Member rows: name links to Hot List filtered by `recruiterId` (once Hot List filters are in the URL — see hotlist.md) — no API change.
- If `addable` is empty, show Add member disabled with hint "No unassigned recruiters right now".
- Swap to `Loading` / `QueryError` primitives.
### Mobile
Already single-column and overflow-free. Raise Add/Remove to 40–44px height on `(pointer: coarse)`.
### Reusable components
Existing: `Person`, `Dialog`, `Loading`, `QueryError`. Share the card header with CoachingPage (same `.team` card) so both screens look identical.

## Before/after interaction comparison
| Task | Before | After |
|---|---|---|
| See r1a's candidates | nav to Hot List → Recruiter filter → pick r1a (3+ actions) | click r1a (1) |
| Try to add when nobody is free | open dialog → see disabled option → cancel (3) | button disabled with reason (0) |

## Expected benefit
Small: clearer counts, one primary action, a direct path from team to the team's pipeline.

## Implementation complexity: S
MyTeamPage.tsx, styles.css (touch sizes). No API changes.

## Scorecard
| Dimension | Score | Evidence |
|---|---|---|
| Usability | 8 | Simple, confirm on remove; Low issues only |
| Visual hierarchy | 7 | #1, #2 |
| Efficiency | 7 | #4 |
| Responsiveness | 8 | No overflow at 390; #3 |
| Accessibility | 8 | aria-labels name the team on each button, live region; #3 |
| Design consistency | 7 | #6; differs from Coaching card layout |

## Validation
Visual inspection: desktop 1440 + mobile 390 as l1, Add dialog opened; targets measured. Redesign validation: pending (not implemented).

### Implemented (wave 2)
| Audit item | Change | Evidence |
|---|---|---|
| #1 N primary buttons for managers (Low) | Add member is primary only when there is one team; otherwise secondary on each card. | `after/myteam-desktop.png` |
| #2 Count excludes the lead (Low) | "2 members + lead". | `after/myteam-desktop.png` |
| #3 30px buttons on touch (Low) | 44px Remove / Add member on phones; Add member full width. | `after/myteam-mobile.png` |
| #5 Add with nobody free (Low) | Add member disabled with "No unassigned recruiters right now" (aria-describedby). | — |
| #6 Plain loading / error (Low) | `Loading` and `QueryError` (retry). | — |
| Shared card | Same header, lead row and "Members"/"Coaches" label as Coach assignments. Remove still confirms (RemoveMemberDialog). | — |
| #4 Member → Hot List link (Low) | Not changed (needs Hot List URL filters by recruiter; outside this area). | — |

Validation (wave 2, 2026-11-05): `pnpm --filter @eureka/web typecheck` clean; full web unit suite 552/552 (admin, staff, training, team suites updated only where markup/interaction changed). Visual check at 1440×900 and 390×844, light and dark, in Playwright against a fixture API built from the `*Api.ts` shapes, because the shared API on :3000 and its Postgres were not running in this environment. Page width at 390 = 390 on every screen below; row actions visible at 1440. Live-data re-check against the seeded API is still owed.

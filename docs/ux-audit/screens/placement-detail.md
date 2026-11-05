# Placement detail — `/placements/<id>`
Status: Audited · Redesign proposed
Who / permission: `placement:read`. Status buttons come from server `allowedTransitions`. BGC initiate needs `bgc.actions`. Documents need `document:read`.
Source: `apps/web/src/pipeline/PlacementsPage.tsx:260-484` (`PlacementDrawer`, `ExitDialog`, `ReinitiateBgcDialog`), `pipeline/ContractsSection.tsx`, `documents/DocumentsSection.tsx`, `sales/ui.tsx` (`Drawer`)
Evidence: `placements-detail-desktop.png`, `placements-detail-desktop-full.png`, `placements-detail-mobile.png`, `placements-detail-mobile-full.png`, new: `placements-detail-bottom-{desktop,mobile}.png`

## Primary objective
See the full state of one placement (facts, contacts, paperwork, BGC, assignment, contracts, documents) and move it to its next status or record an exit.

## What's on screen
Wide drawer (`.drawer.wide`): status + First placement badges; 15-row facts `dl`; Status section (Move to …, Mark BGC initiated / Re-initiate BGC…, Mark backout… / BGC failed… / joining issue…); Contacts mini-table (4 cols); Paperwork checklist (progress bar + 5-col table); Background check; Assignment; Contracts; Placement documents. Exit and re-initiate dialogs require a reason.

## Problems
| # | Problem (evidence) | Category | Severity |
|---|---|---|---|
| 1 | Next steps are buried. The Status action block comes **after** the 15-row facts list (`:304-348`). On desktop it is below the fold, and when the user has no transitions (CEO view) it is missing entirely with no explanation. Yet the BGC section still says "Mark it initiated under Status" (`:400`; `placements-detail-desktop.png`, `placements-detail-bottom-desktop.png`). The copy points to a control that isn't there. | Hierarchy / Cognitive | High |
| 2 | Status "BGC" badge at top vs Background check "Initiated" further down (`placements-detail-desktop.png`). Two vocabularies for one step. There is no stepper showing Confirmed → Paperwork → BGC → Ready → Joined, so the user can't see where the placement is or what's next. | Cognitive | Medium |
| 3 | No links out. The candidate is plain text (`:306`). There's no link to the source submission or the cleared interview, and the recruiter isn't linked. The paperwork checklist doesn't link to Paperwork & BGC for that item (`:377-390`). | Efficiency | Medium |
| 4 | The facts list mixes 15 fields of equal weight. "Existing consultant re-confirmed: No" takes the longest label slot. Created / Last status change are shown, but there's no status history, so the user can't see when the placement entered BGC. | Hierarchy | Low |
| 5 | Mobile: the contacts table shows Kind/Name/Email truncated, and Phone is off-screen (`placements-detail-mobile.png`). The checklist table cuts off "Due" and the Overdue badge, which is the most important column. | Responsive | Medium |
| 6 | Checklist document label "Sample form e" is truncated in a 5-column mini table on desktop (`placements-detail-desktop.png`). | Visual | Low |
| 7 | Exit dialogs say "This can't be undone from this screen" (`:476`), which is good. But the danger buttons sit in the same row as forward moves, with only colour separating them (`:341-345`). | Cognitive | Low |

## Recommended redesign
### Desktop
- Drawer header: candidate (link) · client, status badge, and a compact **stage stepper** (Confirmed · Paperwork · BGC · Ready · Joined) with the current step highlighted.
- Directly under the header: an "Next step" card with the forward action(s) as primary. Exits go in a separate "Other outcomes" disclosure. If no transitions are allowed, show "You can view this placement; status changes are made by <role>".
- BGC copy is conditional: only mention "under Status" when `canInitiateBgc`.
- Facts in 2 columns grouped as Job (client, vendor, type, mode, location, rate), People (recruiter, team, location), Dates (tentative, actual, joined, created). Add a "From submission ·  Open" link.
- Checklist rows link to the Paperwork item. Overdue first.

### Mobile
Contacts and checklist render as stacked definition cards (name, kind, email/phone as tappable links; document, status, due + overdue badge). Stepper scrolls horizontally.

### Reusable components
Existing: `Drawer`, `PipelineStatus`, `ChecklistProgress`, `ExitDialog`. New shared: `StageStepper` (also usable in the submission drawer), `RecordLink`, `NextStepCard` (submission and placement drawers), mini-table → card helper inside `ResponsiveTable`.

## Before/after interaction comparison
| Task | Before | After |
|---|---|---|
| Move placement to next status | Open, scroll past 15 facts, click Move to X = 2 + scroll | Open, primary Next step = 2, no scroll |
| See where a placement is in the process | Read status badge + BGC + assignment sections | Glance at stepper |
| Go to candidate / submission | Not possible from here | 1 click |
| Read overdue item on mobile | Scroll mini-table sideways | Visible in card |

## Expected benefit
The action is visible on open. No misleading copy for read-only roles. Process position is obvious. Mobile drawer readable.

## Implementation complexity: S–M
Web only for the layout, stepper, copy and links (`PlacementsPage.tsx`, `styles.css`). The submission link needs `submissionId` on `Placement` (verify; add to API if absent). Status history would need an API (out of scope; not proposed).

## Scorecard
| Dimension | Score | Evidence |
|---|---|---|
| Usability | 6 | Complete information, guarded exits; misleading BGC copy (#1) |
| Visual hierarchy | 5 | Actions after 15 facts (#1, #4) |
| Efficiency | 6 | Single drawer holds everything; no links (#3) |
| Responsiveness | 5 | Drawer full-width OK; mini-tables clip key columns (#5) |
| Accessibility | 7 | Sections labelled, aria-busy, reason fields required with focus; progress has label |
| Design consistency | 7 | Same drawer/manageblock pattern as submissions |

## Validation
Visual inspection: desktop 1440 and mobile 390 drawer, top and scrolled to bottom (as CEO, who has no transitions on this record). Redesign validation: pending (not implemented).

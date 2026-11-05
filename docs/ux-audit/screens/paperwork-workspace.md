# Paperwork workspace (one placement) — `/paperwork/<placementId>`
Status: Audited · Redesign proposed
Who / permission: same as `/paperwork` (`document:read` / `bgc:update`); actions per item come from `item.actions` / `bgc.actions` (server-decided)
Source: `apps/web/src/paperwork/PaperworkWorkspace.tsx` (801 lines), `documents/DocumentsSection.tsx` (see `documents-section.md`)
Evidence: `paperwork-detail-desktop.png`, `paperwork-detail-desktop-full.png`, `paperwork-detail-mobile.png`, `paperwork-detail-mobile-full.png`, `paperwork-detail-hr-documents-{desktop,mobile}.png`, `paperwork-detail-checklist-{desktop,mobile}.png`, `paperwork-detail-itemdialog-{desktop,mobile}.png`, `paperwork-detail-bgc-{desktop,mobile}.png`

## Primary objective
Move one placement's paperwork forward: mark checklist items received or verified, upload or link documents, and advance the background check, with any gaps visible.

## What's on screen
- Back button, h1 (candidate), a subline (status, type, client, start, recruiter), and 2 stat boxes (Checklist "0 of 2 done", Background check badge).
- 4 tabs (Documents, Checklist [count], Background check [dot], Activity), routed via `?tab=`.
- Right rail: Placement facts (7 rows) and "Needs attention" links.
- Checklist: a 5-column mini table with Update/History per row. The Update dialog has 7 fields (status, reason, owner role, due date, assignee, notes, linked document).
- BGC tab: 5 stacked cards (Status with stepper + move form; Check details view/edit; Employment history with coverage bar; Address history; Notes).

## Problems
| # | Problem (evidence) | Category | Severity |
|---|---|---|---|
| 1 | The default tab is Documents (:42) even when the placement has overdue checklist items. In `paperwork-detail-desktop.png` the user lands on "No documents yet." while the work ("1 checklist item overdue") sits in another tab and in the rail. | Hierarchy | High |
| 2 | The header Checklist stat shows only "0 of 2 done" (:83-86). Overdue and required-open counts appear only in the rail's "Needs attention" box, which on mobile sits after all tab content (`paperwork-detail-mobile.png`, `paperwork-detail-checklist-mobile.png` bottom). | Hierarchy | High |
| 3 | At 390px the checklist mini table scrolls (609px in 336px). The Overdue badge, Update and History are off-screen (`paperwork-detail-checklist-mobile.png`), so the main action on this tab is hidden. | Responsive | High |
| 4 | Failing a BGC is final ("A failed check is final.", :412). It happens from a select plus the "Update status" button (:455) with no confirmation step. The optional "Also mark the placement BGC failed" checkbox (:451-452) changes the placement too, also unconfirmed. Elsewhere the app uses `ConfirmDialog` for irreversible actions (e.g. Remove employer, :654). | Cognitive | High |
| 5 | Item history opens below the whole table (:240), detached from the row whose "History" was pressed. With several items it's unclear which item the history belongs to. The only cue is the `aria-expanded` state. | Cognitive | Medium |
| 6 | The BGC tab stacks 5 full-width cards with a 1,250px page height (`paperwork-detail-bgc-desktop.png`). The Status card always shows an empty "Move to: Choose…" form and a primary "Update status" button, even once the check is Cleared. That's the loudest element on the page for a rarely needed action. | Hierarchy | Medium |
| 7 | The Update dialog mixes a status change with re-assignment, due date, notes and document link (:325-372). Changing the status needs a "No change" select (default) and then Save. Marking an item "Received", the most common action, takes 3 interactions (Update → select → Save). | Efficiency | Medium |
| 8 | The "Received" badge is amber/warn, shown next to a red "Overdue" (`paperwork-detail-checklist-desktop.png`). A received item still reads as overdue, which is ambiguous to the user (is "received" not done?). | Cognitive | Medium |
| 9 | The tablist wraps to 2 rows at 390px (`paperwork-detail-mobile.png`). Arrow keys still work, but the wrapped pills look like filter chips (same `.tab` style as the queue filters). | Responsive | Low |
| 10 | Needs-attention items are 16px-tall `linkbtn`s (measured 147×16, 134×16). They pass 2.5.8 only by the spacing exception, which is weak on touch. | A11y | Low |
| 11 | The coverage bar is `aria-hidden` (:591) with a hidden legend. Gap text is given (good), but the verified / pending / unverified shares are visual only. | A11y | Low |

## Recommended redesign
### Desktop
- Default tab: the first tab with attention (`needsAttention(d)[0]?.tab`), else Checklist. Documents only when no checklist exists.
- Header stat strip: "Checklist 0/2 · 1 overdue · 2 required open" (red chip) | "BGC Cleared". The rail keeps the Placement facts; move "Needs attention" into the header strip as chips that switch tab.
- Checklist rows get an inline primary quick action for the next allowed transition (e.g. "Mark received" when `actions.transition` includes it). Keep "More…" for the full dialog. History expands as a sub-row directly under its item (`<tr className="editing">` pattern already used for EntryForm at :618).
- Failing a BGC opens a `ConfirmDialog` (danger) that restates the "Also mark placement BGC failed" choice.
- Status card: show the stepper and current reason. Hide the move form behind a "Change status" button (same view/edit pattern as Check details, :481).
- Received status uses the neutral/info tone; overdue is suppressed once an item is received or later, if the server treats received as satisfying due (verify with the API; otherwise relabel it "Received · verification overdue").
### Mobile
- Checklist rows become cards: doc name + status badge, "Due Nov 2 · Overdue", then the full-width quick action and "More".
- The tabs become a horizontally scrollable single row (the `.sheetbody .tabs { flex-wrap: nowrap }` pattern, styles.css:1159), or a select.
- Needs-attention chips in the header, before the tabs.
### Reusable components
- Existing: `ConfirmDialog`, `BgcBadge`, `PipelineStatus`, the `.pwstats` strip, the `tr.editing` sub-row.
- New shared: `DueDate` (see `paperwork.md`), `ResponsiveTable` cards, and a `QuickAction` row button pattern shared with Bills ("Mark paid") and Payments ("Record payment").

## Before/after interaction comparison
| Task | Before | After |
|---|---|---|
| Open placement → see what's overdue | Land on Documents → read rail/scroll (mobile) → click Checklist (2-3 steps) | Lands on Checklist with overdue chip (0) |
| Mark item received | Update → status select → Save (3) | "Mark received" (1) |
| Fail BGC | select Failed → Update status (2, no confirm) | select → Update → Confirm (3, deliberate) |
| Read one item's history | History → scroll below table | History expands under row |

## Expected benefit
Less tab-hunting on every visit, one-click progress for the most common change, and a guard on the one irreversible action. Mobile users can act on the checklist without sideways scrolling.

## Implementation complexity: M
PaperworkWorkspace.tsx (default tab, header strip, quick action, history sub-row, confirm), plus CSS for mobile cards. No API change. The quick action uses the existing `updateItem` with `status` only.

## Scorecard
| Dimension | Score | Evidence |
|---|---|---|
| Usability | 5 | Wrong default tab (#1), unconfirmed final action (#4) |
| Visual hierarchy | 5 | Overdue hidden in rail (#2); empty move form dominant (#6) |
| Efficiency | 5 | 3 steps for the most common update (#7) |
| Responsiveness | 4 | Actions off-screen at 390 (#3); wrapped tabs |
| Accessibility | 7 | Proper tabs with arrows/aria-controls, linked errors, focus on first invalid; small linkbtns (#10) |
| Design consistency | 6 | Uses ConfirmDialog elsewhere but not for fail; same pill for tabs/filters |

## Validation
Visual inspection: desktop 1440 and mobile 390 as hr, on all four tabs plus the Update dialog. Overflow measured: page OK, checklist wrap 609/336 at 390. Redesign validation: pending (not implemented).

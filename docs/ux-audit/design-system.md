# Eureka web: design system (current state and proposed direction)

Status: **proposal, not approved.** Phase 3 preview. Nothing here is implemented.
Evidence: [screens/_system.md](screens/_system.md) (counts, contrast, targets) and the screen reports.

## 1. Direction (decided 2026-11-05): rebrand

The user chose a **rebrand**, not the "refine" option this document first proposed. The pinned direction combines the category-standard structure with the Air Waybill identity:
- deep carbon sidebar
- restrained signal-red brand accents
- strong typography
- clean, data-dense layouts
- conventional status chips
- no metaphors and no decoration

The direction contract is in `apps/web/.impeccable/surfaces/src-sales-hotlistpage-tsx.md`. The decision sketches are in `apps/web/.impeccable/mocks/decision/`. Once the finish review passes, `apps/web/DESIGN.md` records the built system and supersedes the token proposals below.

**Implemented in pass 1:**
- Tokens: `--side-*`, `--brand`, `--sel`, `--info-*`, `--field-line`, `--on-pri`, `--r-sm/md/lg`, `--h-control/compact`, `--font`.
- Archivo, self-hosted through `@fontsource-variable/archivo`.
- The BrandMark.
- Carbon primary buttons.
- Underline tabs, distinct from filter toggles.
- Global `:focus-visible`.
- Radii normalised to 4/6/8.
- No resting shadows.
- The list-screen kit: filter bar, selection bar, card table.

### Typography decision (resolved: Archivo, self-hosted)
`font-family: Inter, …` is declared but Inter is **never loaded** (`styles.css:18`), so users already see Segoe UI, SF or Roboto depending on OS. Two options:

| Option | What it means | Trade-off |
|---|---|---|
| **A. Use the system UI stack (recommended)** | Declare the stack honestly. | No dependency, no network cost. What most users see today. Metrics differ slightly across OSes. |
| B. Self-host Inter | Add a woff2 file or `@fontsource/inter`. | Identical metrics everywhere. About 100 KB and a dependency. Inter is the most generic SaaS face. |

Either way: `font-variant-numeric: tabular-nums` on tables and KPIs.

## 2. Tokens (proposed)

### Type scale
Ratio about 1.2, fixed rem, no half-pixels. Replaces 25 distinct sizes.
| Token | Size / line height | Use |
|---|---|---|
| `--fs-xs` | 12 / 16 | meta, table secondary line, badges |
| `--fs-sm` | 13 / 18 | table body (dense), labels, helper text |
| `--fs-md` | 14 / 20 | default body, controls |
| `--fs-lg` | 16 / 24 | card and section titles (h2/h3, one size per role) |
| `--fs-xl` | 20 / 28 | drawer and record titles |
| `--fs-2xl` | 24 / 32 | page h1 (21 on phone, as today) |

Weights: 400 body, 500 controls and labels, 600 headings and emphasis. Drop 700 except the brand.

### Spacing
4px base: `--sp-1..10` = 2, 4, 6, 8, 12, 16, 20, 24, 32, 48. Replaces 28 values; odd steps (3, 5, 7, 9, 11, 13, 15) are removed.

### Radius
`--r-sm` 4 (badges, checkboxes) · `--r-md` 6 (controls) · `--r-lg` 8 (cards, dialogs, drawers) · `--r-pill` 999 (chips, counts). Replaces 20 values.

### Control height
- `--h-compact` 28: dense table row actions, desktop only.
- `--h-control` 36: default button, input, select on desktop.
- `--h-touch` 44: every control at ≤768.

`.btn.sm` (30) becomes `--h-compact` on desktop and `--h-touch` on phones.

### Breakpoints
`--bp-sm` 640 · `--bp-md` 768 (phone/desktop switch) · `--bp-lg` 1024 · `--bp-xl` 1280. 760, 769, 900, 960, 1100, 480 and 520 fold into these.

### z-index
`--z-sticky` 10 · `--z-header` 20 · `--z-drawer` 40 · `--z-popover` 50 · `--z-dialog` 60 · `--z-toast` 70.

### Colour fixes
Contrast is computed against the existing tokens.
| Token | Now | Proposed | Why |
|---|---|---|---|
| `--muted` (light) | #6b7280: 4.40 on `--hover`, 4.27 on `--pri-50` | #5f6675: 5.76 on white, 5.09 on `--pri-50` | muted text on hovered or selected rows fails AA today |
| `--faint` | used as text at 2.37:1 | **decorative only** (dividers, disabled icons); text that uses it moves to `--muted` | masked phones and placeholders fail AA |
| new `--field-line` | inputs use `--line-strong` at 1.33:1 | light #868e9e (3.29:1) · dark #6b7590 (3.86:1) | WCAG 1.4.11 asks 3:1 for field boundaries |
| `--pri-btn` (dark) | #6366f1: white 4.47:1 | #4f46e5: white 6.29:1 | dark primary buttons fail AA |
| bell count | `--bad-fg` (error red; dark 2.69:1) | `--pri-btn`, the same as the chat badge | an unread count is not an error; one meaning for "unread" |
| chart palette | 13 hard-coded hex values in `Charts.tsx:12-14`, the same in dark | `--chart-1..6` tokens with dark variants | theming |
| focus | about 20 per-class opt-ins; inputs glow while buttons outline | one global `:focus-visible { outline: 2px solid var(--pri); outline-offset: 2px }` plus the input glow | one focus language with no gaps |

## 3. Components to standardise
Built once, then adopted screen by screen. **Reuse existing code; no new UI framework.** React + plain CSS stays. The generic kit moves from `sales/ui.tsx` to `ui/` with re-exports, so 17 importing areas keep working.

| Component | Built from | Behaviour |
|---|---|---|
| **DataTable pattern** (CSS plus a small `<Table>` helper) | `.tablewrap`, `table` | Columns tagged `data-priority="1..3"`; priority 3 hidden below `--bp-lg`, priority 2 below `--bp-md`. The row-action cell is sticky on the right on desktop. The whole row opens the record, with a real `<a>`/`<button>` in the first cell for keyboard users. At ≤768 rows become cards: title line, 2–3 key facts, status badge, action. Number columns are right-aligned with tabular numerals. Row height 40 desktop, 36 compact. |
| **FilterBar** | `ListControls.tsx`, `.toolbar` | Search plus N primary filters inline (N ≤ 4, chosen per screen). "More filters (k)" opens a Popover on desktop and a bottom Sheet on mobile (the Dashboard sheet already exists). Active filters show as removable chips with "Clear all", plus a result count. State lives in the URL via `useSearchParam`. Saved views stay. |
| **SelectionBar** | `.selectionbar` (`styles.css:309`, already styled) | Appears only when the selection is non-empty: "n selected · Set status ▾ · Set priority ▾ · Clear". Selection survives paging. |
| **StatusBadge** | `.badge` (66 modifiers) and 5 area components | `<StatusBadge tone="ok\|warn\|bad\|info\|neutral\|accent">label</StatusBadge>` plus per-domain label→tone maps. Always text and tone. |
| **Tabs** | CandidateProfile / Access implementations (keyboard-correct) | `role=tablist`, arrow keys, roving tabindex, an underline style **distinct from filter chips**. Selected tab optionally in the URL. |
| **Chip / Toggle** | `.tab[aria-pressed]` | Filter toggles get a chip style with a count; never the tab style. |
| **Popover / Menu** | 3 hand-rolled versions (UserMenu, Bell, chat) | One component: outside-click and Escape close, focus return. It hosts row "More ⋯" menus, so Delete and Deactivate leave the primary row. |
| **Drawer** | `sales/ui.tsx:69` | Unchanged behaviour, moved to `ui/`. Header has title, status, primary action and More. Every drawer gets a URL. |
| **Dialog** | `ui/Dialog.tsx` | Add an optional `dirty` prop that confirms before closing on backdrop or Escape, and a sticky `.actions` footer. |
| **ActionStrip** (detail views) | new, small | "Next step" plus status at the top of record views: Placement, Payment, Application, Paperwork. |
| **RecordLink** | new, small | Candidate, submission, interview and placement names render as links when the viewer can open the target, and plain text otherwise. |
| **Notice** | `.livemsg` | `tone="success\|info\|error"`; errors use `role="alert"`. |
| **Loading / QueryError** | existing | Replace 25 raw "Loading…" texts and the inline errors that have no Retry, as each screen is touched. |

## 4. Navigation
- **Regroup** `nav.ts` sections by task:
  - **Work:** Hot List, Candidates, Submissions, Interviews, Placements, Chat
  - **Hiring:** Jobs, Applications, Applicants
  - **Operations:** Paperwork, Employees, Payments, Companies, Facilities, DataHub
  - **Training**
  - **Insights:** Dashboard, Performance, Reports, Interview reports, Pipeline
  - **Team & admin:** Preferred Vendors, My team, Coach assignments, Users & Access, Birthdays

  This reorders only; it changes no permissions.
- **Dashboard placement.** Dashboard leaves the top of Work only if you agree. Recruiters land on the Hot List anyway.
- **Sidebar height.** Nav item 36px on desktop (from 42) and section gaps tightened, so 19 items fit in 900px. 44px items in the phone drawer.
- **Phone drawer** becomes a real modal: focus moves in, Tab is trapped, the page behind is inert, and it has a close button.

## 5. Responsive rules
- Desktop ≥1024: optimise for density. Filters in one row, tables at 40px rows, drawers on the right.
- Tablet 768–1023: priority-3 columns hidden, drawers full-height overlays.
- Phone <768:
  - Lists become cards.
  - Filters become a search field plus a Filters button and bottom sheet.
  - The page header shrinks to the h1 plus one primary action; descriptions collapse.
  - Drawers go full-screen.
  - All targets are at least 44px.

## 6. Adoption rule
Components land **inside the first screen that needs them** (the Hot List), not as a big-bang library. Each later screen adopts what exists and adds only what it needs. Hot files (`styles.css`, `nav.ts`, `api.ts`) take small, merged-from-main edits, per CLAUDE.md.

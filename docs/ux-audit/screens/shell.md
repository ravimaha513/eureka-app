# App shell (sidebar, top bar, drawer, quick jump) — every signed-in route
Status: Audited · Redesign proposed
Who / permission: every signed-in user. Nav items filtered by `anyOf`/`allOf` (nav.ts:13-51, `visibleNav` nav.ts:59-62). Measured item counts: ceo 19, l1 19, m1 19, r1a 18, locD 16, hr 14, acct 11, imm 9, coach 7, admin 2. Settings is not in the sidebar; it is reached from the avatar menu and Quick jump (nav.ts:53-57, App.tsx:387).
Source: `apps/web/src/App.tsx:281-508` (Shell), `nav.ts`, `shell/ui.tsx` (NAV_ICONS, Avatar, ThemeSwitch, UserMenu), `shell/QuickJump.tsx`, `shell/OfflineBanner.tsx`, `shell/theme.ts`, `chat/ChatNavBadge.tsx`, `styles.css:41-101` (shell), `:634-691` (phone), `:976-993` (quick jump, offline, skip link)
Evidence: existing `dashboard-desktop.png`, `dashboard-mobile.png`, `candidates-desktop.png`; new `shell-sidebar-ceo-desktop.png`, `shell-sidebar-recruiter-desktop.png`, `shell-collapsed-desktop.png`, `shell-drawer-mobile.png`, `shell-quickjump-desktop.png`, `shell-quickjump-filter-desktop.png`, `shell-quickjump-mobile.png`, `shell-usermenu-desktop.png`, `shell-usermenu-mobile.png`, `shell-focus-skiplink-desktop.png`, `shell-focus-collapse-desktop.png`, `shell-offline-desktop.png`, `shell-overlap-inbox-usermenu-desktop.png`

## Primary objective
Move between ~7–19 work areas fast, see that something needs attention (bell, chat badge), and reach account actions — without the frame eating space that an Operate-mode, table-heavy app needs.

## What's on screen
- Sidebar 264px (80px collapsed): brand row (logo + "Eureka / Staffing pipeline" + collapse button), nav grouped into up to 7 sections in first-seen order (`[...new Set(items.map(i => i.section))]`, App.tsx:328), theme segmented switch pinned to the bottom (App.tsx:436, styles.css:65).
- Rendered CEO nav (measured): **Workspace 7** (Dashboard, Hot List, Candidates, Submissions, Interviews, Placements, *Preferred Vendors*) · Hiring 2 · Operations 4 · Training 1 · Insights 4 · **Other 1 (Chat)** = 19 buttons, 42px each; sidebar content height **1250px vs 900px viewport** — Chat and the theme switch are below the fold.
- Top bar 68px (60px phone): [phone only: menu button + brand] … magnifier "Go to screen" (40×40), bell (40×40), user chip (avatar + name + roles + caret). No page title, breadcrumb or context on the left at desktop.
- Offline banner (role=status) between top bar and content; skip link; screen heading receives focus on navigation (App.tsx:341-362).
- Keyboard: Ctrl/Cmd+K opens Quick jump (App.tsx:385-397); "/" focuses the screen's first `input[type=search]` (App.tsx:369-384) — verified on /candidates.
- Phone ≤768px: sidebar becomes an off-canvas drawer (280px / 85vw) with scrim (styles.css:636-639).

## Problems
| # | Problem (evidence) | Category | Severity |
|---|---|---|---|
| 1 | **Phone drawer is not a modal and does not take focus.** `sideRef.current.querySelector(".nav").focus()` runs while `.side` is still `visibility:hidden`, so focus stays on the menu button (measured: activeElement after open = `button.menubtn`). No focus trap, `.main` not `inert`, no `aria-modal`: 30×Tab from the drawer ends in page content ("Open" button) behind the scrim. No visible close button inside the drawer (only scrim tap / Escape); the menu button is under the scrim (z 55 > top bar z 20). App.tsx:398-406,410,439; styles.css:637-639; `shell-drawer-mobile.png` | A11y | High |
| 2 | **Nav too long for the viewport and ordered by code, not by use.** 19 items / 6 sections for ceo, l1, m1; sidebar 1250px tall at 900px viewport so **Chat (the only item with a live badge) is below the fold**, alone in a section literally called "Other" (nav.ts:50). `vendors`, `myteam`, `coaching` are declared after Insights (nav.ts:41-45) but tagged `Workspace`, so "Preferred Vendors" — a reference list — sits between Placements and Jobs in the daily-work group. `shell-sidebar-ceo-desktop.png`, `shell-sidebar-recruiter-desktop.png` | Efficiency | High |
| 3 | Magnifier icon in the top bar is the **screen switcher**, not search (aria-label "Go to screen", class `bell`; App.tsx:446-447). A recruiter clicking it to find a candidate gets a list of 20 screen names. Nothing in the UI hints at Ctrl+K except a `title` tooltip | Cognitive | Medium |
| 4 | Quick jump input is an unstyled native input: 20px tall, browser black focus ring, no `.field`/`.searchbox` styling (QuickJump.tsx:217; styles.css:977 sets only width). Current screen is listed first and highlighted as if it were the suggestion. `shell-quickjump-desktop.png` | Visual | Medium |
| 5 | Desktop top bar is 68px of mostly empty surface (only 3 controls, right-aligned) above every screen, plus `.content` 28px top padding → first content at y≈96 (dashboard-desktop.png). No screen title/breadcrumb/record context in it, so the h1 repeats below. Costs ~1 table row on every list screen | Efficiency | Medium |
| 6 | Collapsed rail (80px) relies on `title` tooltips for names (App.tsx:424) — not shown on keyboard focus or touch; section names hidden with `font-size:0` (styles.css:72) leaving unlabeled dividers. 19 near-identical outline icons (Users / UsersRound / UserRoundCheck / UserRoundSearch, shell/ui.tsx:9-31). `shell-collapsed-desktop.png` | Cognitive | Medium |
| 7 | Overlays don't coordinate: bell panel and user menu can be open at the same time and overlap (`shell-overlap-inbox-usermenu-desktop.png`); the inbox has no outside-click close (Inbox.tsx:64-68 vs UserMenu outside-click at shell/ui.tsx:72-77) | Visual | Medium |
| 8 | Focus ring inconsistent: `.collapsebtn`, `.userchip`, `.themeswitch button`, `.userpanel-item` have no `:focus-visible` rule → browser `outline:auto 1px` (measured on collapse button, `shell-focus-collapse-desktop.png`), while `.nav`, `.btn`, `.bell` use 2px `--pri` (styles.css:184-185,535) | A11y | Low |
| 9 | Active item is triple-encoded: tinted bg + colour + a 6px dot (`.nav[aria-current]::after`, styles.css:63). The dot also visually collides with the chat count badge position (`.navbadge margin-left:auto`, chat.css:30) | Visual | Low |
| 10 | Theme switch permanently occupies the sidebar footer (36px + padding, styles.css:65-67) and is duplicated on the login page; a once-per-device preference in prime nav space | Hierarchy | Low |
| 11 | Phone top bar targets 40×40 (menu, go-to, bell) — pass 2.5.8 (24px) but under the 44px touch guideline; user chip 44×44 (measured). Settings and Sign out only inside the avatar menu (`shell-usermenu-mobile.png`) | Responsive | Low |
| 12 | Offline banner is in normal flow (App.tsx:453), scrolls away with the page; a user filling a long form below the fold loses the warning (`shell-offline-desktop.png`) | Cognitive | Low |
| 13 | User menu panel: items are plain buttons in a div (no list/menu semantics; fine as disclosure) but "Sign out" hover turns **all** items red (`.userpanel-item:hover { color: var(--bad-fg) }`, styles.css:89) — Settings hovers red too | Visual | Low |

## Recommended redesign
### Desktop
- **Re-group nav by job, not by data type** (nav.ts only; same keys/permissions): `Work` (Hot List, Candidates, Submissions, Interviews, Placements, Chat), `Hiring` (Jobs, Applications, Applicants), `Operations` (Paperwork & BGC, Employees, Payments, Companies, Facilities, DataHub), `Training`, `Insights` (Dashboard, Performance, Reports, Interview reports, Candidate Pipeline), `Admin & team` (Preferred Vendors, My team, Coach assignments, Users & Access, Staff birthdays). Remove "Other". Put sections in `NAV` order explicitly (a `SECTIONS` array) rather than first-seen. Caveat: the landing screen for roles without Hot List is `items[0]` (App.tsx:286) — today Dashboard for hr/acct/imm; keep that by making landing explicit (`dashboard` then first item) before reordering.
- Tighten nav item to 36px and section label padding to 12/4px → 19 items fit in ~880px; move the theme switch into the user menu (it already holds Settings).
- Turn the 68px top bar into a 52px context bar: left = current screen name (+ "← Back to Hot List" when a record is open), right = Quick jump trigger rendered as a **labelled pill** "Go to… Ctrl K" (not a magnifier), bell, avatar. Drop the duplicate h1 subtitle where the bar carries the title, or keep h1 and drop the bar title — one, not both.
- Quick jump: reuse `.searchbox` input styling (38px, 10px radius, focus glow), list the current screen last, show the shortcut hint for "/" next to search inputs.
- Collapsed rail: show a positioned label on `:hover` *and* `:focus-visible` (CSS only, using the existing `.navlabel` text) instead of `title`.
- Single "one popover at a time" rule: opening bell closes user menu and vice versa; inbox closes on outside mousedown (same pattern as UserMenu).
### Mobile
- Drawer = modal: focus first nav item after the transition (or drop `visibility` from the transition), `inert` on `.main` while open, `aria-modal="true"` + `role="dialog"` on the aside, and a 44px close button in the brand row (reuse `.iconbtn`).
- Keep 4 top-bar controls but make them 44×44. Optional: put Chat and Hot List as the first two drawer items (follows from regrouping).
### Reusable components (existing to reuse / new shared ones needed)
- Reuse: `Dialog` focus logic (ui/Dialog.tsx:19-49) for the drawer trap; `.searchbox` input; `.iconbtn`; `UserMenu` outside-click pattern.
- New: `Popover` primitive (anchor, outside-click, Escape, one-open-at-a-time) to replace three hand-rolled disclosures (UserMenu, NotificationBell, chat ConversationMenu ChatPage.tsx:429-463).

## Before/after interaction comparison
| Task | Before (steps/clicks) | After |
|---|---|---|
| CEO opens Chat from Dashboard at 1440×900 | scroll sidebar + click (2) | click (1) — Chat in first group, nav fits |
| Keyboard user on phone opens nav and picks Candidates | Enter on menu; focus stays on menu button; Tab ×? lands in page behind scrim | Enter → focus on first item → ↓/Tab ×2 → Enter |
| Find "Payments" screen | scan 19 items / 6 headers, or guess magnifier | Ctrl K (pill shows it) → type "pay" → Enter |
| Close the inbox after reading | click × (18px) or click bell again | click anywhere outside / Esc |

## Expected benefit
All 19 items + Chat badge visible without scrolling on a 900px laptop; ~16px more vertical space on every screen; phone nav becomes operable by keyboard/screen-reader (fixes a WCAG 2.4.3 focus-order issue); fewer mis-taps on "search" that isn't search.

## Implementation complexity: S/M
M overall. nav.ts section regroup + explicit section order (S, hot file); styles.css nav/top-bar sizing (S); drawer focus/inert/close button in App.tsx:398-443 (S); shared Popover + adopting it in UserMenu/NotificationBell (M). No API changes.

## Scorecard (1–10, evidence-based)
| Dimension | Score | Evidence |
|---|---|---|
| Usability | 6 | Clear labels, URL routing, focus-to-h1 on navigation; but Chat below fold and magnifier ≠ search (#2, #3) |
| Visual hierarchy | 6 | Clean, calm sidebar; top bar empty, triple-encoded active state, "Other" section (#5, #9) |
| Efficiency | 5 | Ctrl+K and "/" exist (good), but 19-item scroll and 68px bar on every screen (#2, #5) — one High |
| Responsiveness | 5 | Drawer works by touch; no close button, 40px targets, no modal behaviour (#1, #11) |
| Accessibility | 5 | Skip link, aria-current, live chat count, heading focus are strong; drawer focus/trap failure is High (#1) |
| Design consistency | 6 | Uses tokens throughout; Quick jump input and focus rings off-system (#4, #8) |

## Validation
Visual inspection: desktop 1440×900 (ceo, r1a sidebars captured at full height), collapsed rail, Quick jump empty + filtered, user menu, offline banner, overlapping popovers; mobile 390×844 drawer, user menu, Quick jump. Keyboard: Tab order from page load (skip link → collapse → nav), drawer focus and Tab escape measured with Playwright. Redesign validation: pending (not implemented).

# Cross-cutting design-system audit — `apps/web/src/styles.css` + area kits
Status: Audited · Inventory for the design-system proposal
Scope: the de-facto system shared by all screens: tokens, type, spacing, radii, controls, status badges, tabs, overlays, states, breakpoints, focus, motion, contrast, target size.
Source: `apps/web/src/styles.css` (1168 lines, 96.5 KB, **408 top-level class selectors**, ~1044 rule blocks), `chat/chat.css`, `jobs/jobs.css`, `feedback/feedback.css`; `ui/Dialog.tsx`, `ui/Loading.tsx`, `ui/QueryError.tsx`, `ui/Pager.tsx`, `ui/Charts.tsx`; area kits `sales/ui.tsx`, `pipeline/ui.tsx`, `paperwork/ui.tsx`, `sites/ui.tsx`, `training/ui.tsx`, `shell/ui.tsx`
Evidence: all `screenshots/before/*`, especially `login-dark-desktop.png`, `shell-focus-collapse-desktop.png`, `settings-notifications-desktop.png`, `chat-create-group-desktop.png`, `notifications-panel-desktop.png`. Counts below are from `grep` over the files listed (method noted per row).

## 1. Tokens (styles.css:2-36)
- Light + dark sets for: surfaces (`--bg --surface --surface2 --hover`), lines (`--line --line2 --line-strong`), text (`--text --text2 --muted --faint`), brand (`--pri --pri-btn --pri-btn-hover --pri-50/100/200/700`), status triplets (`--ok-* --warn-* --bad-*` bg/fg/line), `--neutral-*`, `--violet-*`, 6 avatar tints (`--t-*`), 2 shadows, `--scrim`, **one** radius (`--radius:14px`).
- **Missing token layers**: no type scale, no spacing scale, no radius scale (only 1 of 20 radius values is a token; `var(--radius)` used **once**), no control-height token, no z-index scale (9 distinct z values: 1,2,5,20,30,50,55,60,100), no focus-ring token, no chart palette tokens (Charts.tsx:12-14 hard-codes 13 hex values, identical in dark mode).
- Font: `font-family: Inter, system-ui, …` (styles.css:18) but **Inter is never loaded** (no `@font-face`, no Google Fonts link in `index.html`, no `@fontsource` dep). Users without a local Inter get Segoe UI / SF / Roboto → metrics differ per OS. Impeccable "overused font Inter" (styles.css:18): **valid, with a twist** — the real problem is an unshipped font, not the choice.

## 2. Quantified inventory (feeds the proposal)
| Property | Distinct values | Distribution / notes (grep method) |
|---|---|---|
| font-size (styles.css) | **25** (23 px values + `0` + `.9em`) | 12px×36, 13px×27, 12.5px×24, 15px×11, 11px×10, 16px×8, 11.5px×8, 14px×7, 22/20/18/17/14.5px×3, 24/10.5px×2, 34/32/30/28/26/21/13.5/10px×1. Half-pixel sizes (10.5, 11.5, 12.5, 13.5, 14.5) = 5 of them (`grep -oE 'font-size: *[^;}]+'`) |
| Heading sizes | h1 24 / 21 (phone) / 32 (login); **h2 at 15, 16, 17, 18, 20, 34px**; **h3 at 12.5, 13, 14, 14.5, 15px and UA default (~16.4px)** | per-context overrides (`.card.pad h2`, `.cardhead h2`, `.drawerhead h2`, `.dialog h2`, `.lochead h2`…), e.g. Settings h3 > h2 (settings.md #4) |
| font-weight | 4 (400×2, 500×13, **600×51**, 700×21) | 600 is the de-facto body-emphasis weight |
| padding/margin/gap px values | **28** | 8px×114, 10px×103, 12px×96, 6px×78, 4px×60, 16px×54, 14px×42, 2px×29, 20/18px×18, 3px×12, 7px×9, 24px×9, 5px×7, 40/32/28px×5, 1px×5, 11px×4, 9px×3, 44/36/22px×3, 26px×2, 56/48/15/13px×1. Odd steps (3,5,7,9,11,13,15) = 7 values |
| `gap` alone | 25 distinct declarations | 8px×53, 10px×44, 6px×36, 12px×33, 4px×24, 16px×18 … |
| border-radius | **20** | 10px×28, 999px×26, 8px×18, 12px×14, 50%×10, 9px×5, 6px×5, 7/5/4/3/16/14px×2, 24/20/11px×1, `var(--radius)`×1 |
| Control heights | **10** | chipx 18, iconbtn.sm 28 (chat.css) / 30 (styles.css), btn.sm 30, pager 32, collapsebtn 32, iconbtn 34, themeswitch 36, btn 38 / searchbox 38, field input 40 / bell 40 / menubtn 40, nav 42, btn.block & login select 46 |
| box-shadow | 18 distinct | only 2 are tokens (`--shadow-sm`, `--shadow-lg`) |
| Breakpoints | **9 distinct widths**, 26 `@media` blocks | max 480, 520, 640 (×4), 760, 768 (×9 + 2 motion), 769 (min), 900, 960 (×3), 1100 (×2). 768 is the real phone/desktop switch; 760 and 769 are near-duplicates |
| Hard-coded colours | **29** hex in styles.css outside the token blocks (16 distinct) + **12** `rgba()`; 16 hex in chat/jobs/feedback css (feedback.css: 13, its own palette); **19** in TSX (Charts.tsx 13, App.tsx 6 login SVG) | e.g. `.btn[type=submit].danger { background:#dc2626 }` (styles.css:213) bypasses `--bad-*`; `.agebar .c2/.c3 #f59e0b/#f43f5e` (:512); `.logo` gradient (:51); login hero (:148-160); `.rankbar` gradient (:1119); `.docx` (#fff/#111/#ccc, :1000-1004 — legit: document preview) |
| Inline `style={{}}` in TSX | 20 | mostly dynamic widths (fine); 5 static (SettingsPage.tsx:110, BirthdayFields.tsx:20, UsersTab.tsx:459,577,583, BulkCandidatesDialog.tsx:124, JobsPage/ApplicantsPage/ApplicationsPage `flex:1`) |

## 3. Component families (de-facto)
| Family | What exists | Problems |
|---|---|---|
| Buttons | `.btn` + `.primary .ghost .outline .danger .sm .block` (styles.css:206-214, 551-553); `.iconbtn` (+`.sm .danger`, :344-346, 615-618); `.linkbtn`, `.linkish`, `.cardopen`; area one-offs `.bell`, `.menubtn`, `.collapsebtn`, `.chipx`, `.chat-send`, `.userpanel-item`, `.themeswitch button`, `.settingsnav button`, `.chat-conv`, `.rtbtn` | `.btn.danger` is outline-red **except** inside `type=submit` where it becomes solid #dc2626 (:212-213) — same class, two looks depending on markup. `.iconbtn:disabled` declared twice with opacity .5 and .4 (:616, :740). `.linkbtn` (no underline, `--pri-700`) vs `.linkish` (underlined) for the same job |
| Fields | `.field` wrapper (label 13px/600, input/select 40px radius 10, `--line-strong`) (:193-205); `Field` component in **sales/ui.tsx:29** | `.field textarea` declared twice (:438 border `--line` radius 8; :598 background) → textareas have a lighter border and smaller radius than inputs (`settings-desktop.png` bio box). 176 raw `className="field"` vs 207 `<Field>` usages — two ways to build a field. `.searchbox input`, `.chat-search`, `.dh-search`, `.dh-searchbox`, `.searchfield`, Quick jump input = **6 search-input styles** |
| Cards / sections | `.card`, `.card.pad`, `.cardhead/.cardtools/.cardfoot`, `.panelhead`, `.attention`, `.tile/.kpi`, `.chartcard`, `.team`, `.loccard` | `.card.pad h2` 15px vs `.cardhead h2` 16px vs `.panelhead h3` 15px for the same "card title" role |
| Tables | global `table/th/td` (:106-111), `.tablewrap` (73 uses / 63 tables), `.rowactions`, `.mini` | at ≤768 every `.tablewrap > table:not(.mini)` gets `min-width:640px` (:654) → horizontal scroll is the only phone strategy |
| Status | `.badge` + **66 modifier classes** in 11 prefixes (`st-`×19, `resume-`×6, `workauth-`×4, `tr-`×4, `pay-`×4, `bgc-`×4, `emp-`×3, `cl-`×3, `bill-`×3, `ver-`×2, unprefixed ×14) all mapping to the same 5 tones (ok/warn/bad/pri/neutral/violet). Plus `.prio`, `.tag`, `.chip`, `.chipcount`, `.tabcount`, `.tabdot`, `.navbadge`, `.chat-unread`, `.bell-count`, `.livemsg`, `.badge.pill` | 5 area components render badges (`StatusBadge` sales/ui.tsx:18, `PipelineStatus` pipeline/ui.tsx:22, `BgcBadge` paperwork/ui.tsx:18, `BatchStatusPill` training/ui.tsx:23, `StatusPill`/`BillStatusPill` sites/ui.tsx:18-21) + 27 raw `className="badge…"`. Count bubbles: chat uses `--pri-btn`, bell uses `--bad-fg` |
| Tabs / toggles | `.tabs/.tab` with `aria-pressed` (17 uses, filter-style), `role=tablist` with `.tab[aria-selected]` (12 files), `.tabs.seg` segmented (:1100-1102), `PillTabs` (sites/ui.tsx:77), `.settingsnav` vertical tabs, `.chat-filters`, `.themeswitch` | 6 visual treatments for "pick one of N"; pill `.tab` is used both for real tabs and for filters, so users can't tell navigation from filtering |
| Overlays | `Dialog` (ui/Dialog.tsx, 88 usages; focus trap, Escape, return focus — solid), `ConfirmDialog`, `.dialog.wide/.xwide/.sheet/.quickjump/.docviewer`; `Drawer` (**sales/ui.tsx:69**, 17 usages); popovers hand-rolled 3× (UserMenu shell/ui.tsx:65-95, NotificationBell, chat ConversationMenu) | no shared Popover; shell drawer re-implements modal behaviour without the trap (shell.md #1) |
| States | `Loading` (63 usages), `QueryError` with Retry (38), `.empty` with masked icon (:122-128), `.error` | **25** raw "Loading…" texts and **118** `className="error"` paragraphs bypass them (e.g. Inbox.tsx:127-128, ChatPage.tsx:117-118) → no spinner, no Retry |
| Pager | `ui/Pager.tsx`, used in 13 files; 32px segmented buttons | consistent; 32px < 44px touch |
| Shared-kit placement | `sales/ui.tsx` exports `Field` (26 importing files' uses), `fmtDate` (25), `Drawer` (15), `useFocusAfterFailure` (14) and is imported by **17 areas** (admin, chat, dashboard, datahub, employees, interviews, jobs, paperwork, payments, performance, pipeline, pipelinereport, portal, settings, sites, training, workauth) | generic primitives live in a feature folder; `ui/` holds only 6 files. `pipeline/ui.tsx` likewise exports generic `useDebounced` |

## 4. Global CSS leaks
- `chat/chat.css` is imported by `ChatNavBadge` (shell, always loaded) and defines app-wide selectors: `.dot` (chat.css:4, 9px, `--faint`) overrides `styles.css:1114` (8px) used by Dashboard legend dots; `.iconbtn.sm` 28px (chat.css:66) overrides 30px (styles.css:615) on every screen. Fix: namespace (`.chat-dot`) and load chat.css with the chat chunk.
- `feedback/feedback.css` has its own 13-colour palette (public feedback page) — acceptable for a public surface but not tokenised.

## 5. Accessibility metrics
### Contrast (WCAG 2.x, computed from tokens)
| Pair | Light | Dark | Verdict |
|---|---|---|---|
| `--muted` on `--bg` / `--surface` | 4.52 / 4.83 | 6.47 / 5.99 | pass, but **4.40 on `--hover`** and **4.27 on `--pri-50`** (light) — fails where muted text sits on hovered rows / selected items (e.g. `.qjsec` on selected Quick-jump row, styles.css:981-983) |
| `--faint` on `--bg` / `--surface` | **2.37 / 2.54** | **4.03 / 3.73** | fails 4.5:1 in both themes. Used for **text**: `.masked` (masked phone numbers, :117), placeholders (:205, :572), disabled pager text (:234), `.rtarea` placeholder (jobs.css:16); and as the only "offline" presence cue (chat.css:4) |
| white on `--pri-btn` | 6.29 | **4.47** (#6366f1) | dark primary buttons fail 4.5:1 for 14–15px/600 text (`login-dark-desktop.png`) |
| white on `--bad-fg` (bell count) | 6.47 | **2.69** (#fb7185) | fails in dark |
| `--warn-fg` on `--warn-bg` | 4.68 | — | pass (just) |
| Input border `--line-strong` on `--surface` | **1.33:1** | 1.52:1 | fails WCAG 1.4.11 (3:1) for form-field boundaries; inputs are identifiable mainly by label position (`settings-desktop.png`, `login-desktop.png`) |
### Focus
- No global `:focus-visible` rule; 2px `--pri` outlines are opted into per class in **~20 selector lists** (styles.css:184-185, 235, 246, 278, 332, 346, 535, 641, 724, 802, 866, 992, 1130; chat.css:21; jobs.css:13). Classes not listed fall back to the UA ring (measured `outline: auto 1px` on `.collapsebtn`): `.collapsebtn`, `.userchip`, `.themeswitch button`, `.userpanel-item`, `.qjlist`/Quick-jump input, `.chat-search input` (outline 0, uses focus-within glow — OK).
- Inputs use a glow ring (`box-shadow 0 0 0 3px --pri-100`, :186) while buttons use an outline — two focus languages, both visible.
### Motion
- `prefers-reduced-motion` handled for every animation found (spinner :135, switch :402, drawer :691, accordion :831, sheet :1165, chat actions chat.css:107). 13 transition/animation declarations total. **Good.**
### Target size at 390px (measured with Playwright, `getBoundingClientRect`)
| Control | Size | 24px (2.5.8 AA) | 44px guideline |
|---|---|---|---|
| `.chipx` (inbox close, chip remove, attachment remove) | 18×18 | **fail** | fail |
| Chat people-picker checkbox rows | ~20px tall | **fail** | fail |
| `.iconbtn.sm` (chat edit/delete) | 28×28 | pass | fail |
| `.btn.sm` (Mark read, Sign out, Open) | 30–34px tall | pass | fail |
| `.pager` buttons | 32px | pass | fail |
| Settings tabs / `.tab` pills | 35px / ~33px; `.tab.sm` ~25px | pass | fail |
| `.btn` | 38px | pass | fail |
| Top bar menu / go-to / bell | 40×40; user chip 44×44 | pass | fail / pass |
| `.nav` items (drawer) | 252×42 | pass | ~ |
| `.btn.block` (login) | 46px | pass | pass |
Page-level horizontal overflow at 390: none on login, chat, settings, dashboard (scrollWidth = 390).

## 6. Impeccable detector findings — verdicts
| Finding | Verdict |
|---|---|
| styles.css:18 overused font Inter | **Valid (reframed)**: Inter is declared but never shipped → inconsistent rendering; choose and self-host one family or commit to `system-ui` |
| styles.css:150 grid-line background (login hero) | **Valid**: decorative grid + gradient + fake KPI cards (login.md #4) |
| styles.css:887 side-stripe border | **False positive (keep, adjust)**: `tbody tr.row-cleared td:first-child { box-shadow: inset 3px 0 0 var(--ok-fg) }` is a row-state marker in the interview-reports table, not a decorative card stripe. It is colour-only (paired with green row tint); the existing `.badge.cleared` (:888) should also appear in the row so the state isn't conveyed by colour alone |
| styles.css:910 side-stripe border | **False positive**: `.orgtree ul { border-left: 2px solid var(--line) }` is the tree connector line of the org chart (hierarchy guide), standard pattern |

## 7. Highest-leverage system fixes (for the proposal)
1. **Type scale**: collapse 25 font sizes to 7 (11, 12, 13, 14, 16, 20, 24 + display 32), no half-pixels; fixed h2/h3 sizes per level; ship the font.
2. **Spacing scale** 4-based (2, 4, 8, 12, 16, 20, 24, 32, 40) → replaces 28 values; **radius scale** (4, 8, 12, pill, circle) → replaces 20.
3. **Control heights**: 28 / 36 / 44 (sm / md / touch) applied to btn, iconbtn, input, select, tab, pager; `.chipx` → min 24.
4. **Contrast**: raise `--faint` to ≥4.5:1 (or stop using it for text); `--line-strong` → a 3:1 `--field-border`; dark `--pri-btn` → #5b5ff0-ish ≥4.5 with white; dark bell bubble text.
5. **Promote kits**: move `Field`, `Drawer`, `useFocusAfterFailure`, `fmtDate`, `useDebounced` to `ui/`; one `StatusBadge({tone,label})` replacing 66 modifier classes + 5 area badge components (area code maps status → tone); one `Popover`; one `Tabs` (tablist) vs one `FilterChips` (aria-pressed); one `SearchInput`.
6. **States**: lint/replace 25 raw "Loading…" and inline load errors with `Loading`/`QueryError`.
7. **Global focus**: `:where(button, a, [tabindex], input, select, textarea):focus-visible { outline: 2px solid var(--pri); outline-offset: 2px }` + a `--focus` token; delete per-class lists.
8. **Breakpoints**: 3 tokens (sm 640, md 768, lg 1100); retire 480/520/760/769/900/960.
9. **Namespace area CSS** (chat.css `.dot`, `.iconbtn.sm`) and lazy-load it.

## Validation
Counts from grep over the CSS/TSX files named above (commands reproducible: `grep -oE 'font-size: *[^;}]+' styles.css | sort | uniq -c`, etc.). Contrast computed with the WCAG relative-luminance formula from token hex values. Target sizes and overflow measured in Chromium (Playwright) at 390×844 on login, dashboard, chat, settings and the shell. Not a full per-screen sweep of every control — other screen reports carry their own measurements.

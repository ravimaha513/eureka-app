# Notifications (bell + inbox panel) — top bar, every route
Status: Audited · Redesign proposed
Who / permission: every signed-in user (no capability gate; Shell renders `NotificationBell` unconditionally, App.tsx:448). Which entries open a record depends on the screens the user has (`canOpenEntity`, App.tsx:314-316). Per-type in-app on/off lives in Settings → Notifications.
Source: `apps/web/src/notifications/Inbox.tsx` (160 lines), `App.tsx:312-327,448`, `styles.css:532-546`, `.chipx` `styles.css:223-224`
Evidence: existing `dashboard-desktop.png` (bell with count); new `notifications-panel-desktop.png`, `notifications-panel-mobile.png`, `shell-overlap-inbox-usermenu-desktop.png`

## Primary objective
Notice that something needs me (unread count), scan what happened, jump to the record, and clear what I've handled.

## What's on screen
- Bell 40×40 round button with red count bubble ("99+" cap), polled every 60s; polite live region announces growth only (Inbox.tsx:21-62).
- Panel (380px, max 70vh, absolute under the bell; fixed full-width under the top bar on phones, styles.css:537, :672): header h2 "Notifications" + "Mark all read" (btn sm) + "×" (chipx 18×18). List of 20 per page; each entry = title (underlined link button if openable, else bold text) + body paragraph + timestamp + "Mark read/unread" btn sm. "Show older notifications" for the next page. States: "Loading…", "Could not load notifications.", "No notifications yet." as plain `<p>`.
- Measured for ceo: 1 entry ("Project assignment ended"), entry height ~140px incl. button.

## Problems
| # | Problem (evidence) | Category | Severity |
|---|---|---|---|
| 1 | Close "×" is **18×18px** (`.chipx`, Inbox.tsx:124, styles.css:223; measured 18×18 desktop and phone) — below WCAG 2.5.8 24px minimum, and the glyph is a text "×" at 14px | A11y | High |
| 2 | Panel never closes on outside click (no document mousedown handler, Inbox.tsx:64-68) and Escape works only while focus is inside the panel (`onKeyDown` on the section, :120). It stays open over the page and can be open together with the user menu, overlapping it (`shell-overlap-inbox-usermenu-desktop.png`) | Efficiency | Medium |
| 3 | Every entry carries its own "Mark read" button even though opening the title already marks it read (Inbox.tsx:137-149). Entries are ~140px tall: only ~3–4 fit in 70vh on a laptop; no type icon, no grouping by day, no relative time ("Nov 5, 2026, 2:35 AM") | Efficiency | Medium |
| 4 | Count bubble uses `--bad-fg` (error red) for routine counts (styles.css:536) while the chat badge uses `--pri-btn` (chat.css:29) — two colour meanings for "unread". Dark theme: white on #fb7185 = **2.69:1** (fails 1.4.3; bubble text is 11px) | Visual / A11y | High |
| 5 | States bypass shared primitives: plain "Loading…" text instead of `Loading` (spinner + role=status), and load error has **no Retry** unlike `QueryError` (Inbox.tsx:127-128 vs ui/QueryError.tsx) | Consistency | Medium |
| 6 | Unread entry styling is heavy: tinted card + border + bold + underlined link (styles.css:542-546, `.linkish` underline) — every unread item looks like an error/notice block; read items lose the link look entirely when not openable (`<strong>`) so it is unclear which titles are clickable | Visual | Low |
| 7 | "Mark all read" bounds to the newest *loaded* entry (Inbox.tsx:113-116) — correct, but the button gives no feedback beyond the count change; no live message like Settings' `.livemsg` | Cognitive | Low |
| 8 | Panel is a non-modal `section` that receives focus on its h2 (Inbox.tsx:68,122) — good — but Tab past the last entry walks into the page behind while the panel stays open (no auto-close on focus-out) | A11y | Low |

## Recommended redesign
### Desktop
- Use a shared `Popover` (see shell.md): outside click, Escape anywhere, one popover at a time, close on focus-out.
- Compact rows (~56px): leading 16px type icon (map `entity.type` → existing lucide icons from NAV_ICONS: placement BadgeCheck, interview CalendarClock, conversation MessageCircle…), title as the row's single button (whole row clickable; marks read on open), body clamped to 2 lines, relative time right-aligned ("2h", "Yesterday"). Unread = 6px `--pri` dot + bold title, no tinted card.
- Per-row "Mark read/unread" becomes a 28px `.iconbtn.sm` (Check / CircleDot) revealed on hover/focus-within, always visible on touch.
- Day separators ("Today", "Yesterday", date) — the chat `.chat-day` pill already exists.
- Count bubble → `--pri-btn` (same as chat) or keep red only for mandatory types; fix dark-mode contrast by using a dark text or a darker red token.
- Close → `.iconbtn` 32×32 with lucide `X`.
- States: `<Loading />` and `<QueryError query={q} …/>`.
### Mobile
- Full-width sheet under the top bar is right; make it `max-height: calc(100dvh - 72px)` and sticky header so "Mark all read" stays reachable while scrolling; 44px close.
### Reusable components (existing to reuse / new shared ones needed)
- Reuse: `Loading`, `QueryError`, `.iconbtn`, `.chat-day` (promote to a generic `.daysep`), `NAV_ICONS`.
- New: `Popover` primitive (shared with UserMenu and chat ConversationMenu).

## Before/after interaction comparison
| Task | Before (steps/clicks) | After |
|---|---|---|
| Open a notification's record | open bell → click underlined title | open bell → click anywhere on row |
| Dismiss panel after glancing | hit 18px × or the bell | click outside / Esc from anywhere |
| Scan 10 new notifications on a laptop | scroll (3–4 visible) | 8–9 visible at once |
| Load error | no recovery; close and reopen | Retry button |

## Expected benefit
2–3× more entries per screen, one-click open, consistent unread language with Chat, two WCAG failures fixed (target size, dark contrast).

## Implementation complexity: S
Inbox.tsx + styles.css:532-546 (+ new Popover if done with the shell work, M). No API changes (all data already returned: type, entity, createdAt, readAt).

## Scorecard (1–10, evidence-based)
| Dimension | Score | Evidence |
|---|---|---|
| Usability | 6 | Works, deep-links into records, marks read on open; sticky panel, no outside close (#2) |
| Visual hierarchy | 5 | Every unread is a tinted, underlined block; red count for routine items (#4, #6) |
| Efficiency | 5 | Tall rows, redundant per-row button (#3) |
| Responsiveness | 7 | Full-width fixed panel at 390, no overflow; small close target (#1) |
| Accessibility | 5 | Good labels, live count announcements, focus to heading; target-size and dark contrast failures (#1, #4) |
| Design consistency | 5 | Own loading/error text, own disclosure logic, badge colour differs from chat (#4, #5) |

## Validation
Visual inspection: panel open at 1440 and 390 (ceo, 1 entry), overlapping user menu, outside-click behaviour measured with Playwright. Empty / error / multi-page states reviewed from code only (seed data has one notification). Redesign validation: pending (not implemented).

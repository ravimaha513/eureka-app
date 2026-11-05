# Settings & Preferences — `/settings`
Status: Audited · Redesign proposed
Who / permission: every signed-in user (`SETTINGS_NAV.anyOf = []`, nav.ts:57); reached from the avatar menu (shell/ui.tsx:89) or Quick jump, not the sidebar. `calendar/SupportCalendar.tsx` is **not** used here (only InterviewsPage.tsx:15).
Source: `apps/web/src/settings/SettingsPage.tsx` (211 lines), `settings/settingsApi.ts`, `staff/BirthdayFields.tsx`, `Field`/`useFocusAfterFailure` from `sales/ui.tsx`, `ConfirmDialog` from `ui/Dialog.tsx`; API copy source `apps/api/src/modules/identity/settings.service.ts:48`; styles `styles.css:862-875`, `.switch` `:393-402`
Evidence: existing `settings-desktop.png`, `settings-desktop-full.png`, `settings-mobile.png`, `settings-mobile-full.png`; new `settings-notifications-desktop.png`, `settings-security-desktop.png`, `settings-profile-mobile.png`, `settings-security-mobile.png`

## Primary objective
Let a staff member keep their own contact details current, turn noisy in-app notifications off, and check/end their sign-in sessions.

## What's on screen
- h1 + sub; 2-column grid 220px tabs card + panel card (single column ≤ breakpoint, tabs become a wrapping row, styles.css:873-874).
- Vertical tablist (Profile, Notifications, Security) with roving tabindex + arrow keys (SettingsPage.tsx:32-56).
- Profile: avatar + name + email, read-only infogrid (Display name "(from your Google account)", Designation, Location), Work phone, Short bio (0/500), Birthday (Month select + Day input), Save profile, footnote.
- Notifications: hint + **16 switches** (2 mandatory, rendered disabled), one flat list (`settings-notifications-desktop.png`).
- Security: sign-in note, h3 "Login activity", sessions table (Signed in, Device, IP, Last seen, Sign out) — **13 rows** for ceo, 12 per-row "Sign out" buttons — and "Sign out of all other sessions" (danger), both behind ConfirmDialog.

## Problems
| # | Problem (evidence) | Category | Severity |
|---|---|---|---|
| 1 | Security says **"Development sign-in (no password)."** for every non-Google mode, including staging password sign-in: the API maps any `AUTH_MODE !== "google"` to `"dev"` (settings.service.ts:48, settingsApi.ts:5, SettingsPage.tsx:169-170). Profile likewise claims the display name comes "from your Google account" (SettingsPage.tsx:98). Password users get wrong security information, and there is no way to change a password voluntarily even though the endpoint exists and is used by the forced flow (App.tsx:109) | Cognitive | Medium |
| 2 | Mandatory notification rows are rendered as disabled switches at `opacity:.6` with **`cursor: progress`** (styles.css:398 — the busy style), so "can't be turned off" looks like "loading/broken"; the reason is only in the description text (SettingsPage.tsx:149-152, `settings-notifications-desktop.png`) | Visual | Medium |
| 3 | 16 switches in one undifferentiated list with long descriptions; no grouping (Placements & employees / Paperwork / Hiring / Payments / Performance / Chat) and no "all on/off". Panel is 1100px tall at 1440 | Efficiency | Medium |
| 4 | Heading hierarchy inverted: h2 "Security" is 15px (`.card.pad h2`, styles.css:385) while the nested h3 "Login activity" has no rule and renders at the UA default ~16.4px, so the child looks bigger than its parent (`settings-security-desktop.png`) | Hierarchy | Medium |
| 5 | Sessions table lists every sign-in as an identical "Desktop · Chrome · 127.0.xx.xx" row with its own Sign out (13 rows for ceo). The Sign out column is clipped at the card edge on desktop (button border cut at x≈1390, table wider than `.card.pad`; `settings-security-desktop.png`) and needs horizontal scroll on phone (`settings-security-mobile.png`) | Efficiency | Medium |
| 6 | Active tab is not in the URL (`useState("profile")`, SettingsPage.tsx:30): refresh/back always returns to Profile, unlike the rest of the app which routes state (App.tsx:284-293); the "New direct message" notification can't link to `/settings/notifications` | Efficiency | Low |
| 7 | Birthday label is a styled `span` with inline style (`style={{ fontWeight: 600, fontSize: 13 }}`, SettingsPage.tsx:110) instead of a `legend`/`Field`; Month select is full width while Day is 80px (inline style in BirthdayFields.tsx:20) — on phone they stack (`settings-profile-mobile.png`) | Consistency | Low |
| 8 | Read-only identity facts (name, designation, location) take a full row above editable fields and show "—" for most staff; the avatar block repeats the user chip | Hierarchy | Low |
| 9 | Phone tabs become 35px-tall wrapping pills (measured 92×35 / 135×35 / 105×35) — fine but < 44px; session "Sign out" buttons 94×34 | Responsive | Low |

## Recommended redesign
### Desktop
- Tabs as routes: `/settings/profile|notifications|security` (parseScreenPath already yields `id` → reuse it as the tab key; App.tsx:287). Keep the tablist semantics.
- Profile: single 640px column; identity facts as one muted line under the name ("Senior Recruiter · Dallas"); fields via `Field` incl. Birthday as a `fieldset`/`legend`.
- Notifications: group rows under small h3s by domain (derive from the preference `type` prefix or a static map in the web app); mandatory rows show a "Required" `.badge` instead of a disabled switch; switch rows 48px.
- Security: copy from the real auth mode (needs API to return `"password"` — see complexity); a "Change password" button (opens the existing ChangePassword form in a Dialog) when mode is password. Sessions: current session pinned on top; others collapsed into "12 other active sessions · Sign out all" with an expandable table; fix the table width (let Device wrap, `td.wrap`).
- Give `.card.pad h3` an explicit size below h2 (13–14px, `--text2`).
### Mobile
- Tabs as a full-width 3-segment control (`.tabs.seg`), 40px tall. Sessions as stacked cards (when, device, last seen, Sign out) instead of a 640px-min table.
### Reusable components (existing to reuse / new shared ones needed)
- Reuse: `Field`, `ConfirmDialog`, `.tabs.seg`, `.badge`, `ChangePassword` form body (App.tsx:86-125).
- New: `SwitchRow` (label, description, switch, optional Required badge) — the `.prefrow` + `.switch` pattern is settings-only today but notification preferences are the canonical case.

## Before/after interaction comparison
| Task | Before (steps/clicks) | After |
|---|---|---|
| Turn off all "Payment" notifications | find 2 rows in 16, 2 clicks | open "Payments" group, 2 clicks (scan 2 rows, not 16) |
| Password user changes their password | impossible unless admin resets | Security → Change password (2 clicks + form) |
| Return to Security after refresh | click Security again | stays on `/settings/security` |
| Sign out stale sessions | scan 13 rows; or one "all others" button | one visible "Sign out all other sessions" next to the count |

## Expected benefit
Correct security information for password users, a self-service password change, shorter notification panel, and fixed heading hierarchy.

## Implementation complexity: M
SettingsPage.tsx + styles.css (S). **API change needed** for #1: `settings.service.ts:48` must return `"password"` when password sign-in is the mode (and the web `SignIn` type extended). Change-password UI reuses an existing endpoint. Tab routing touches App.tsx:487 (pass `recordId` as tab).

## Scorecard (1–10, evidence-based)
| Dimension | Score | Evidence |
|---|---|---|
| Usability | 7 | Clear, focused scope, confirm dialogs, saved/live messages; wrong auth copy (#1) |
| Visual hierarchy | 6 | Inverted h2/h3, read-only facts first (#4, #8) |
| Efficiency | 6 | Flat 16-row list, 13 session rows (#3, #5) |
| Responsiveness | 7 | No page overflow at 390 (measured), tabs wrap; table scrolls, 34–35px targets (#5, #9) |
| Accessibility | 8 | Proper tablist with roving focus, `role=switch` with labelledby/describedby, focus after failed save; disabled-looking mandatory switches (#2) |
| Design consistency | 6 | Inline styles, busy cursor reused for mandatory, Field vs raw markup mix (#2, #7) |

## Validation
Visual inspection: desktop 1440 all three tabs (full page), mobile 390 Profile and Security (full page); overflow and target sizes measured. Session count is inflated by audit sign-ins in the shared dev DB but the layout issue holds for any user with >3 sessions. Redesign validation: pending (not implemented).

# Sign in, Set password, Change password — `/` (signed out), `/set-password`, forced change
Status: Audited · Redesign proposed · Regression-checked (rebrand wave 2; no changes needed)
Who / permission: signed-out visitors; `/set-password#token=…` for invited users; `ChangePassword` replaces the app while `me.mustChangePassword` (App.tsx:545). Methods come from `/api/auth/methods` (password, Google) plus dev sign-in in `import.meta.env.DEV`.
Source: `apps/web/src/App.tsx:52-262` (DEV_USERS, PasswordForm, ChangePassword, SetPassword, Login), `App.tsx:526-536` (boot/error), `shell/useAuthMethods.ts`, `styles.css:145-180` (login), `:204-214` (fields/buttons)
Evidence: existing `login-desktop.png`, `login-mobile.png`; new `login-error-desktop.png`, `login-error-mobile.png`, `login-1024.png`, `login-dark-desktop.png`, `login-focus-desktop.png`, `login-setpassword-invalid-desktop.png`

## Primary objective
Get a staff member signed in within one action using the method their environment offers, and recover clearly from a wrong password, lockout or dead invite link.

## What's on screen
- Desktop ≥961px: two columns 1.1fr / 1fr. Left = decorative hero (`aria-hidden`): violet gradient, 56px grid-line overlay, fake app card with KPI tiles "Submissions 48 / Interviews 28 / Placements 8 / Joined 5", a teal area chart, a "Pipeline funnel" card with 48/28/14/8, headline "Welcome to Eureka" (App.tsx:190-219). Right = form column 420px.
- Form (dev/local, as captured): brand + theme chip "Light"; h1 "Hi, welcome back!"; sub; Email, Password, **Sign in**; sub "Or, for development…"; "Sign in as" select (9 users); **Sign in**; footer note. 2 inputs + 1 select + 3 buttons.
- Staging/prod variant (code): Email/Password + "Sign in" then "Or sign in with your company Google account" + **Sign in with Google** — both `btn primary block` (App.tsx:80,250).
- ≤960px: hero hidden; form only (styles.css:180).
- SetPassword / ChangePassword: same right-column box without hero (App.tsx:101-123, 144-179).

## Problems
| # | Problem (evidence) | Category | Severity |
|---|---|---|---|
| 1 | Theme chip's visible text ("Light"/"Dark" = current state) is not in its accessible name ("Switch to dark theme"), App.tsx:224-227 — WCAG 2.5.3 Label in Name (Level A). Voice-control users saying "click Light" fail; sighted users read it as a status, not an action. `login-desktop.png`, `login-dark-desktop.png` | A11y | Critical (rubric: WCAG A; low-traffic control) |
| 2 | Password errors render **below the dev/Google section**, ~190px from the password field, not tied to inputs (no `aria-invalid`/`aria-describedby`), App.tsx:256 vs 76-80. On phone the error is under the second "Sign in" (`login-error-mobile.png`) — reads as if the dev sign-in failed | Cognitive | High |
| 3 | Two equal-weight primary buttons labelled identically "Sign in" (dev, App.tsx:80 & 245) — and on staging "Sign in" + "Sign in with Google" are both solid primary (App.tsx:250). No primary method; users must read helper copy to choose. `login-desktop.png` | Hierarchy | Medium |
| 4 | Hero takes **50% of a 1440px screen** (714px) to show fabricated metrics (48/28/8/5, funnel 48→28→14→8) that look like real company numbers; grid-line background (styles.css:150-151, impeccable "grid background" finding — valid) + gradient + glassy cards are generic SaaS decoration with no information for an internal tool. Shown even at 1024px (`login-1024.png`) where it squeezes the form column | Visual | Medium |
| 5 | Dark theme: white "Sign in" text on `--pri-btn` #6366f1 = **4.47:1** (<4.5:1, 15px/600 is not large text), styles.css:24,210, `login-dark-desktop.png`. Same token used by every primary button in dark mode | A11y | High |
| 6 | ChangePassword shows the password rule only after failure ("Use 10 to 72 characters…", App.tsx:95); SetPassword shows it up front as `.hint` (App.tsx:173). Same rule, two behaviours | Consistency | Medium |
| 7 | `.loginbox .sub { margin: -6px 0 6px }` (styles.css:173) pulls the helper line onto the "Email" label (4px gap) while the gap after the field is 12px — helper reads as a label prefix. `login-desktop.png` | Visual | Low |
| 8 | Control heights mixed inside one form: inputs 40px, select 46px, buttons 46px (styles.css:174,176,204; measured 420×40 / 420×46) | Visual | Low |
| 9 | Error/locked copy relies on `role=alert` only; the form doesn't move focus to the error or the first invalid field, unlike in-app forms that use `useFocusAfterFailure` (sales/ui.tsx:53) | A11y | Low |
| 10 | Greeting "Hi, welcome back!" is shown to first-time Google users; brand appears twice on desktop (hero card + form header) | Cognitive | Low |

Impeccable detector: `styles.css:150` grid-line background — **valid** (decorative hero). `styles.css:18` Inter — see `_system.md` (declared, never loaded).

## Recommended redesign
### Desktop
- Single centered 400px card on `--bg` (or keep a **narrow** 360px brand column with logo + one sentence, no fake data). Remove `.heroshots`, `.herogrid` and the hard-coded hero palette (styles.css:146-169, App.tsx:190-219).
- Order by environment: the server-preferred method is the only primary button ("Continue with Google" on prod; "Sign in" on staging), the other is `btn outline block` under an "or" divider. Dev sign-in moves into a collapsed `<details>` "Development sign-in" with `btn ghost`.
- Errors inline: render the PasswordForm error directly under the Password field (`.error.fielderr`), set `aria-invalid` on both inputs and `aria-describedby` to the error; focus the error on failure.
- Theme toggle: icon-only `.iconbtn` with name "Dark theme" + `aria-pressed`, or drop it from the login page (the shell has one).
- Same 40px height for inputs/select; `.btn.block` 44px.
### Mobile
- Already single-column; apply the same method hierarchy and inline errors; keep 44px buttons. Reduce top whitespace (currently ~100px above the brand, `login-mobile.png`).
### Reusable components (existing to reuse / new shared ones needed)
- Reuse `Field` (sales/ui.tsx:29) for email/password so hint/error/aria wiring matches the app; reuse `useFocusAfterFailure`.
- New: `AuthCard` wrapper shared by Login / SetPassword / ChangePassword / boot error (App.tsx:531) — they already share `.loginpage > .loginpanel > .loginbox`.

## Before/after interaction comparison
| Task | Before (steps/clicks) | After |
|---|---|---|
| Wrong password on phone, notice what failed | type, submit, scroll/scan below second button | error appears under Password, focus moved there |
| Prod user signs in with Google | read 2 sub-lines, pick between two primary buttons | one primary button, 1 click |
| Voice-control user toggles theme | "click Light" fails | "click Dark theme" works |

## Expected benefit
Faster, unambiguous first action; fixes one WCAG A and one AA failure; removes ~120 lines of decorative CSS/SVG and the fabricated metrics.

## Implementation complexity: S
App.tsx:58-262 + styles.css:145-180 only. No API changes.

## Scorecard (1–10, evidence-based)
| Dimension | Score | Evidence |
|---|---|---|
| Usability | 6 | Works, good autocomplete attrs and specific error copy (App.tsx:70-72, 92-99); error placement misleads (#2) |
| Visual hierarchy | 5 | Two identical primaries; half-screen decoration (#3, #4) |
| Efficiency | 7 | 1–2 actions to sign in; password managers supported |
| Responsiveness | 8 | Clean single column at 390, no overflow (measured 390/390), 46px buttons |
| Accessibility | 4 | Label-in-name A failure (#1) + dark primary contrast AA failure (#5) |
| Design consistency | 5 | Hero uses 8 hard-coded colours off-token; control heights mixed (#4, #8) |

## Validation
Visual inspection: desktop 1440 (light, dark, focus state, rate-limited error), 1024, mobile 390 (default + error), invalid set-password link. Note: the error capture shows the 429 lockout message because the shared dev API was rate-limited during the audit; placement is identical for 401. ChangePassword not rendered (needs an admin-set password user) — reviewed from code. Redesign validation: pending (not implemented).

### Wave 2 regression check
Login was rebuilt in an earlier wave; the shell wave changed only signed-in code (App.tsx `Shell`, `shell/shell.css`). Re-captured at 1440 light and 390 dark: layout, theme toggle and both sign-in forms unchanged; page width 390 at phone width. Evidence: `after/login-desktop.png`, `after/login-mobile.png`. No changes made.

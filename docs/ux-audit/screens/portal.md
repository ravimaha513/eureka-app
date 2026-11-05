# Applicant portal ("Eureka Careers") — `/portal/*`
Status: Audited · Redesign proposed · Implemented (rebrand wave 2; signed-out job listing deferred: API change)
Who / permission: external applicants with their own portal session (one-time email link, no password). No staff permission applies. Routes: `/portal/sign-up` (default when signed out), `/portal/sign-in`, `/portal/verify#token=…`, `/portal/jobs`, `/portal/applications`.
Source: apps/web/src/portal/PortalApp.tsx, PortalJobs.tsx, PortalApplications.tsx, portalApi.ts; apps/web/src/jobs/jobs.css:41-73 (portal styles); docs/jobs-portal-api.md:89 (jobs endpoints)
Evidence: public-portal-desktop.png, public-portal-mobile.png, portal-signedout-jobs-{desktop,mobile}.png, portal-signin-{desktop,mobile}.png, portal-signin-sent-{desktop,mobile}.png, portal-verify-{desktop,mobile}.png, portal-verify-expired-desktop.png, portal-jobs-{desktop,mobile}.png, portal-jobs-{desktop,mobile}-full.png, portal-jobdetail-{desktop,mobile}.png, portal-applications-{desktop,mobile}.png, portal-appdetail-{desktop,mobile}.png

Mode: Persuade/Operate hybrid. A candidate on a phone must be convinced to apply (Persuade) and then track their status (Operate).

## Primary objective
A candidate finds an opening, understands it, applies with as little friction as possible, and later checks the status of the application and its interview times and links.

## What's on screen
- Signed out: any `/portal/*` path except sign-in/verify renders "Create your account" (4 fields: first, last, phone, email) (PortalApp.tsx:181). Sign-in has 1 email field. Verify has a single "Continue" button.
- Signed-in shell: sticky top bar (logo, "Eureka Careers" hidden ≤768px, Jobs / My applications, theme toggle, sign out), main column, footer "Signed in as …".
- Jobs ("Finding Job"): card grid (3 columns at 1440px, 1 at 390px). Each card has title, employer · location, 3 pills (work mode, employment type, "Open"), excerpt, "n days ago", "View details" + "Apply now" (or disabled "Applied"). "Show more" pagination. 3 published jobs seeded.
- Job drawer: location · mode · type · level, skill pills, Description, Requirements, Apply button at the end.
- My Applications: Status select, table (Job title, Company, Applied, Status, View/Withdraw), withdraw confirm. Application drawer: status pill + Interviews table only.

## Problems
| # | Problem (evidence: file:line / screenshot) | Category | Severity |
|---|---|---|---|
| 1 | **Account wall before any job is visible.** A signed-out visitor to `/portal` or `/portal/jobs` gets "Create your account" with no openings, no company context, and no sign that jobs exist (PortalApp.tsx:181; portal-signedout-jobs-mobile.png). Job links cannot be shared to job boards or by recruiters. After sign-in the user always lands on `/portal/jobs` (PortalApp.tsx:134), so a deep link would be lost anyway. The API also requires the session for `GET /jobs` (jobs-portal-api.md:89). | Hierarchy | Critical |
| 2 | **One-tap irreversible apply.** "Apply now" posts immediately, with no review step (PortalJobs.tsx:18-22), right next to "View details" in a 2-column card footer (portal-jobs-mobile.png). Withdrawing "cannot be undone" (PortalApplications.tsx:63), so a mis-tap on a phone becomes a permanent application record. | Cognitive | High |
| 3 | **Status hidden on mobile.** On My Applications at 390px only Job title, Company and part of Applied are visible. Status and the View/Withdraw buttons are off-screen to the right (portal-applications-mobile.png; table PortalApplications.tsx:38-55; sticky first column styles.css:958). Status is the only reason this screen exists. | Responsive | High |
| 4 | The apply confirmation is a live message at the top of the list ("Application sent…", PortalJobs.tsx:35, :39), while the tapped card can be 1–2 screens below on mobile. On error from the drawer, the drawer closes and the error appears off-screen at the top (PortalJobs.tsx:80). | Cognitive | Medium |
| 5 | The job drawer omits the employer (PortalJobs.tsx:76 lists location, mode, type, level only), although the card shows it. The Apply button sits only at the end of the content, not sticky (PortalJobs.tsx:80), so long descriptions push it below the fold. | Hierarchy | Medium |
| 6 | The page title "Finding Job" (PortalJobs.tsx:38) is ungrammatical for an external, brand-facing page. | Visual | Medium |
| 7 | On mobile the product name is hidden (`.portaltop .brandname {display:none}`, jobs.css:68). A candidate arriving from an email sees only an icon, and "My applications" wraps to 2 lines inside a 38px button (portal-jobs-mobile.png, portal-applications-mobile.png). The theme toggle takes header space ahead of sign-out. | Hierarchy | Medium |
| 8 | Sign-up asks for the phone (strict E.164 "with the country code") before the email, and blocks submission on phone format (PortalApp.tsx:66, :81). This adds friction before the candidate has seen a single job. | Efficiency | Medium |
| 9 | Each card repeats a green "Open" pill (PortalJobs.tsx:51) although the portal only lists open jobs (jobs-portal-api.md:89). It is noise next to useful pills. | Visual | Low |
| 10 | The application drawer shows only status + interviews (PortalApplications.tsx:70-99). It has no applied date, job summary or Withdraw, and on the empty state the drawer is a full-screen page with one line of text (portal-appdetail-mobile.png). | Hierarchy | Low |
| 11 | No search or filter on jobs (location, remote, type). Acceptable with 3 jobs, but cards are the only navigation. | Efficiency | Low |
| 12 | The auth card nearly touches the screen edges at 390px (`.authcard` width min(440px,100%), margin 16px auto, no side gutter; jobs.css:58, :72; portal-signin-sent-mobile.png). | Visual | Low |

## Recommended redesign
### Desktop
- Public browse (**requires an API change**: an unauthenticated read of published open jobs, the same fields as today's `GET /jobs`). Signed out, `/portal/jobs` shows the cards with "Sign in to apply". "Apply" opens sign-in/up and returns to `/portal/jobs/<id>` after verify (keep the path through the email link). Without the API change: show a short "Open positions at Eureka companies — sign up to see and apply" teaser and keep the intended path for after verify.
- Routed job detail `/portal/jobs/<id>`: employer, location, type pills, skills, description, requirements, and a sticky footer "Apply for this job".
- Apply review step (no API change): a confirm sheet "Apply to *HR Generalist* at *Eureka Info Tech* as Mina Park (mina.park@…)? Your profile details are shared with the hiring team." with Apply / Cancel. On success, show the status inline on the card ("Applied · View application").
- Title "Open positions". Drop the "Open" pill.
- My Applications: card list (job title, employer, applied date, big status pill, next interview time + "Join" link when present), with Withdraw inside the detail.
### Mobile
- Header: logo + "Careers" text kept, nav as 2 equal tabs below the header (or a bottom tab bar). Move the theme toggle into an overflow menu.
- Job detail full-screen with a sticky 48px Apply button.
- Sign-up: email first, then name. Phone optional at sign-up if the API allows; otherwise accept local formats with a country picker (needs API confirmation; the API currently requires phone).
### Reusable components
- Existing: `Drawer`, `ConfirmDialog`, `Field`, `.jobcard`, `.okbox`, status badges.
- New shared: `ResponsiveTable` card mode (shared with staff lists); `StickyFooter` for drawers/dialogs.

## Before/after interaction comparison
| Task | Before | After |
|---|---|---|
| Candidate clicks a shared job link (new) | Sign-up form → email → open the link → Continue → lands on the job list → find the job → View details → Apply (≈8, job unseen until step 6) | See the job → Apply → sign up → email link → Continue → back on the job → Confirm (≈6, job seen first) *(API change)* |
| Apply from the list on a phone | Tap "Apply now" (1, no review) | Tap Apply → Confirm (2, deliberate) |
| Check application status on a phone | My applications → swipe the table sideways | My applications (status visible on the card) |
| Join an interview | My applications → swipe → View → find "Join link" in the table | My applications → "Join" on the card |

## Expected benefit
A higher apply funnel (jobs visible before the account wall), fewer accidental and irreversible applications, and status/interview info readable on the device candidates use.

## Implementation complexity: M (L with public browse)
Portal files + jobs.css only for #2–#12. Public browse (#1) needs a new unauthenticated jobs read endpoint and a rate-limit review (API change, flagged).

## Scorecard
| Dimension | Score | Evidence |
|---|---|---|
| Usability | 4 | Account wall before any job (#1, Critical); one-tap irreversible apply (#2) |
| Visual hierarchy | 6 | Clean cards; detail lacks employer and the CTA is not sticky (#5); brand hidden on mobile (#7) |
| Efficiency | 5 | Deep link lost after sign-in (#1); status needs a sideways swipe (#3) |
| Responsiveness | 5 | Cards are good at 390px; My Applications status off-screen (#3); nav wraps (#7) |
| Accessibility | 7 | Labelled fields, `aria-current` nav, `aria-label` on card buttons, live messages; messages far from the trigger (#4); targets 38px (<44) |
| Design consistency | 6 | Uses staff tokens and components; "Finding Job" copy (#6); redundant pill (#9) |

## Validation
Visual inspection: desktop 1440 + mobile 390, signed out (sign-up, sign-in, link sent, expired link) and signed in as seeded applicants mina.park and venkat.rao via the dev mailbox link (jobs, job drawer, My applications, application drawer with an interview). Apply and Withdraw were not submitted, to keep seed data intact. Measured: no horizontal overflow; all targets ≥38px high. Redesign validation: pending (not implemented).

### Implemented (wave 2)
| Audit item | Change | Evidence |
|---|---|---|
| #1 Account wall before any job (Critical) | **Not built.** A signed-out job listing needs an unauthenticated read of published jobs (API change). Sign-up and sign-in work as before. | (deferred: API change) |
| #2 One-tap irreversible apply (High) | "Apply now" (on the card or as "Apply for this job" in the detail) now opens a review step: "Apply for <title>". It shows the job and employer, says that the hiring team sees the name, email (shown) and phone from the account, and offers Send application / Cancel. Nothing is sent before Send. Withdraw keeps its confirmation ("…cannot be undone"), and it is also available inside the application detail. | `after/portal-apply-mobile.png`, PortalScreens.test.tsx |
| #3 Status hidden on mobile (High) | My applications uses the kit `dtable`. On phones each application is a card with the job title, mode/type/location, a large status chip, company, applied date, last update and Withdraw / View (40px). | `after/portal-applications-mobile.png` |
| #4 Confirmation far from the card (Medium) | After applying, the card itself shows "Application sent. Follow it under My applications" (a link), and the button becomes a disabled "Applied". The drawer shows the same message in its footer. Apply errors stay in the confirm dialog. | `after/portal-desktop.png` |
| #5 Drawer lacks employer; Apply not sticky (Medium) | The detail opens with "Employer · location" and a facts list (work mode, employment, experience, hours, posted). Apply sits in a sticky 44px footer. | `after/portal-job-mobile.png` |
| #6 "Finding Job" (Medium) | The page is titled "Open positions" with a count. | `after/portal-desktop.png` |
| #7 Brand hidden on mobile; nav wraps (Medium) | The header uses the shared BrandMark with the "EUREKA / CAREERS" wordmark at every width. On phones, Jobs / My applications form a two-tab row under the header, with the signal-red underline on the current tab. The theme switch is an icon button, and Sign out keeps its label. | `after/portal-mobile.png` |
| #8 Phone before email at sign-up (Medium) | Email now comes before phone, and each field says why it is needed. Phone stays required, as the API requires it. | `after/portal-signup-mobile.png` |
| #9 Redundant "Open" pill (Low) | Removed. Cards show work mode, employment type and experience. | `after/portal-desktop.png` |
| #10 Thin application drawer (Low) | Added an action strip with the status, "Applied … · updated …" and Withdraw, plus a job summary line. Interviews are shown as cards on phones, each with a "Join link" button. | `after/portal-appdetail-mobile.png` |
| #11 No job search (Low) | Not built (3 seeded jobs; not worth the extra controls yet). | — |
| #12 Auth card touches the edges (Low) | The card is `min(440px, 100% - 32px)` with 44px fields and 16px inputs on phones. | `after/portal-signup-mobile.png` |

Validation (wave 2): typecheck passes. Unit tests pass (`vitest run src/portal` 9/9, including review-before-apply and withdraw-confirm). The shared API was down, so I checked on Vite :5206 with the portal API mocked (fictional applicant; Apply and Withdraw were not sent) at 1440 and 390, light and dark. Page width stays 1440 / 390.

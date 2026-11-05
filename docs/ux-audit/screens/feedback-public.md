# Public interview feedback — `/feedback/<token>`
Status: Audited · Redesign proposed
Who / permission: anyone holding a 43-character emailed token (no session; PublicFeedback.tsx:13, :29). The form is answered by the **interviewee** (the consultant/candidate) about their client interview ("How was your interview?", "Questions you found difficult"), not by an interviewer.
Source: apps/web/src/feedback/PublicFeedback.tsx, feedback/feedback.css; mounted outside the staff app in main.tsx:25, :33
Evidence: feedback-public-{desktop,mobile}.png, feedback-public-{desktop,mobile}-full.png, feedback-public-focus-{desktop,mobile}.png, feedback-public-error-{desktop,mobile}.png, feedback-public-invalid-{desktop,mobile}.png. (The older public-feedback-*.png shows the staff login, not this form.)

Limitation: the dev DB has no `eureka.feedback_delivery` rows, and tokens are stored only as SHA-256 hashes, so no real token could be recovered. The form was rendered by the real app with a Playwright route mock of `GET /api/public/feedback/<token>` (fictional invitation) and a mocked 500 on POST for the error state. Success and 429/410 states were reviewed from code only.

## Primary objective
A consultant finishes a client interview, taps the emailed link on their phone, and submits a rating (required) plus optional details within a minute, once.

## What's on screen
- Card (max 600px): "Eureka" wordmark, H1, greeting with client name, local date/time.
- Form: required rating (5 radio "buttons" labelled 1–5 + scale hint), 6 optional fields (format select, duration number, topics comma text, 3 textareas), "Send feedback", and an expiry/usage note under the form.
- States: loading, invalid/expired (alert only), network/429 error with "Try again", submit error (alert at the top), thank-you.
- Page height 1429px at 390px (feedback-public-mobile-full.png).

## Problems
| # | Problem (evidence: file:line / screenshot) | Category | Severity |
|---|---|---|---|
| 1 | Submit errors render at the **top** of the card (PublicFeedback.tsx:113), and focus does not move there. On a phone the submit button is about 1,180px lower, so after tapping "Send feedback" nothing visibly happens (feedback-public-error-mobile.png). The user may close the page thinking it was sent, though the copy says "Your feedback is still here." | Cognitive | High |
| 2 | "Send feedback" stays disabled until a rating is picked (PublicFeedback.tsx:145) and nothing says why. The rating is 1,000px above it on mobile. | Cognitive | Medium |
| 3 | The rating scale mixes two axes: "1 = very difficult · 5 = very positive" (PublicFeedback.tsx:127). Difficulty and sentiment are different questions, so a hard but positive interview has no correct answer, and the bare numbers 1–5 have no labels on the options. | Cognitive | Medium |
| 4 | Rating options show no focus on the 48px label: the only focus indicator is the browser outline on the 13px native radio (feedback.css:11-12; measured `outline: auto 1px` on `INPUT[name=rating]`; feedback-public-focus-mobile.png). This is weak, though not absent, for WCAG 2.4.7/2.4.11. | A11y | Medium |
| 5 | Hard-coded hex colors (feedback.css:1-18: `#f4f5fa`, `#5144d8`, `#5b6476` …) instead of the theme tokens: no dark mode, and the brand differs from the portal and login (text wordmark vs the logo tile in portal-jobs-mobile.png). | Visual | Medium |
| 6 | 6 optional fields with equal visual weight make a 1-minute task look like a long survey (1429px on mobile). "Anything you'd like your team to know?" comes last, after two narrower textareas. | Hierarchy | Medium |
| 7 | Expiry is printed with raw `toLocaleString()` including seconds ("11/6/2026, 3:00:00 PM", PublicFeedback.tsx:148), unlike the interview date formatting at PublicFeedback.tsx:118, and only below the form where it is read after the fact. | Visual | Low |
| 8 | The submit button is 38px tall and left-aligned at the very bottom (feedback-public-error-mobile.png). On a phone a full-width 48px button is the norm. | Responsive | Low |
| 9 | The invalid-link state has no way forward beyond "contact your recruiter", with no recruiter name or reply path (PublicFeedback.tsx:11; feedback-public-invalid-desktop.png). | Cognitive | Low |

## Recommended redesign
### Desktop
- Keep a single column (max 600px). Order: greeting + interview date → **rating** (5 labelled segments: "Very poor · Poor · OK · Good · Very good" on one axis, "How did it go?") → "Anything you'd like your team to know?" textarea → disclosure "Add interview details (optional)" containing format, duration, topics, difficult questions and next steps.
- Submit: keep it enabled; on submit without a rating show an inline error under the rating group and move focus to it. On server errors render the alert directly above the submit button and move focus to it (`tabIndex=-1` + focus).
- Put "Expires Nov 6, 3:00 PM · one response" under the greeting, formatted like the date at line 118.
- Use the shared tokens (`--bg --surface --text --muted --pri`) so dark mode and brand match the portal; reuse the `.brand` logo markup.
- Focus style: `.feedback-ratings label:has(input:focus-visible) { outline: 2px solid var(--pri); outline-offset: 2px }`.
### Mobile
- Full-width 48px submit, sticky at the bottom once a rating is chosen. With details collapsed, the page is about 700px instead of 1429px.
### Reusable components
- Existing: `.btn.primary.block` (styles.css:176), `.brand`/logo from PortalApp.tsx:26, theme tokens.
- New: a `RatingScale` (segmented radio group with labelled options and a visible focus ring), also usable for the staff Review dialog (application-detail.md #3).

## Before/after interaction comparison
| Task | Before | After |
|---|---|---|
| Submit a rating only (phone) | Rate → scroll 1,000px → Send (scroll + 2 taps) | Rate → Send (sticky) (2 taps) |
| Notice a failed submit (phone) | Must scroll to the top to discover the error | Error next to the button, focused |
| Understand why Send is disabled | Not explained | Inline "Choose a rating" on submit |

## Expected benefit
Higher completion and fewer silent failures on phones, a clearer rating, and consistent branding/dark mode.

## Implementation complexity: S
PublicFeedback.tsx + feedback.css only. No API change (same fields, same POST).

## Scorecard
| Dimension | Score | Evidence |
|---|---|---|
| Usability | 6 | Silent error on mobile (#1), unexplained disabled submit (#2) |
| Visual hierarchy | 6 | 6 equal optional fields (#6); expiry note at the end (#7) |
| Efficiency | 6 | Long scroll for a 1-field task (#6) |
| Responsiveness | 6 | No overflow, 16px inputs on mobile (feedback.css:18), 48px rating targets; error placement (#1), small submit (#8) |
| Accessibility | 6 | Fieldset/legend, labels, `role=alert`, required radios; weak rating focus (#4), focus not moved to errors (#1) |
| Design consistency | 4 | Hard-coded palette, no dark mode, different brand mark (#5) |

## Validation
Visual inspection: desktop 1440 + mobile 390 with a mocked invitation (see Limitation), keyboard Tab into the rating group, mocked submit failure, invalid-token state. Redesign validation: pending (not implemented).

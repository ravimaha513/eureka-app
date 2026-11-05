# Applicants — `/applicants`
Status: Audited · Redesign proposed
Who / permission: `applicant:read` (HR) (nav.ts:24). Phones are unmasked only with `applicant.phone:read` (ApplicantsPage.tsx:12).
Source: apps/web/src/jobs/ApplicantsPage.tsx, applicationsApi.ts
Evidence: applicants-desktop.png, applicants-mobile.png, applicants-desktop-full.png, applicants-mobile-full.png

## Primary objective
HR finds a careers-portal account (by name or email) to check that they exist and are verified, and how many applications they have, or exports the list.

## What's on screen
- Page head: H1, subtitle, "Export" (always shown).
- Filters: 1 search ("Name or email").
- Table: 6 columns (Name with avatar, Email, Phone, Email verified Yes/No, Applications count, Signed up). No row action and no drill-down. Pager with an empty left side.

## Problems
| # | Problem (evidence: file:line / screenshot) | Category | Severity |
|---|---|---|---|
| 1 | Dead end: the Applications count is plain text (ApplicantsPage.tsx:61) and the name does not open anything. Applications already supports `?q=` (ApplicationsPage.tsx:45), yet seeing a person's applications takes nav → search → retype the email. | Efficiency | Medium |
| 2 | At 390px only Name and a cut-off Email are visible. Verified, Applications and Signed up are off-screen with no hint (applicants-mobile.png). | Responsive | Medium |
| 3 | No result count: the list footer renders an empty `<span />` (ApplicantsPage.tsx:71), unlike Jobs/Applications, which announce "n on page x". The table also has no `aria-busy` while refetching (ApplicantsPage.tsx:52; Jobs has it at JobsPage.tsx:96). | Consistency | Low |
| 4 | Export errors appear in the green `.livemsg` success box (ApplicantsPage.tsx:37-38, styles.css:190). | Visual | Medium |
| 5 | "Email verified" as a full Yes/No column (136px) for a boolean. Unverified accounts, the only interesting case, do not stand out (applicants-desktop.png). | Hierarchy | Low |
| 6 | Phones are shown in raw E.164 ("+12125550113"), which is harder to read and check than a grouped format (applicants-desktop.png). | Visual | Low |

## Recommended redesign
### Desktop
- Name as `.linkbtn` → `/applications?q=<email>`. The Applications count becomes the same link ("1 application →").
- Replace the "Email verified" column with an "Unverified" warning badge next to the email (none when verified).
- Add a footer count like Jobs ("3 applicants on page 1") and `aria-busy`.
- Format phones for display (keep E.164 in exports).
### Mobile
- Card: name (link), email + unverified badge, "n applications · signed up date".
### Reusable components
- Existing: `Person`, `.linkbtn`, `.badge` (warn), `Pager`.
- New shared: `Notice` (success/error) and `ResponsiveTable` card mode (same as other list screens).

## Before/after interaction comparison
| Task | Before | After |
|---|---|---|
| See a person's applications | Nav → Applications → type the email → wait (3+) | Click the name/count (1) |
| Find unverified accounts | Scan the Yes/No column | Spot the warning badge |
| Read the row on a phone | Swipe sideways | Card shows everything |

## Expected benefit
Applicants becomes a route into Applications instead of a dead end. Mobile rows are readable.

## Implementation complexity: S
ApplicantsPage.tsx only (+ shared card CSS). No API change (`q` search on applications exists).

## Scorecard
| Dimension | Score | Evidence |
|---|---|---|
| Usability | 7 | Simple and clear; dead end (#1) |
| Visual hierarchy | 7 | Clean; boolean column is noise (#5) |
| Efficiency | 6 | No drill-down (#1) |
| Responsiveness | 5 | 4 of 6 columns off-screen (#2) |
| Accessibility | 7 | Labelled search, table label; no count announcement/aria-busy (#3), errors styled as success (#4) |
| Design consistency | 6 | Footer and busy state differ from sibling lists (#3) |

## Validation
Visual inspection: existing hr screenshots at desktop 1440 and mobile 390, plus measurements as hr (no overflow; smallest target the 32px pager on desktop). Redesign validation: pending (not implemented).

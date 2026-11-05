# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users
- **Primary:** recruiters in the sales teams of an IT staffing firm (bench sales), with their leads and managers. About 180 of the roughly 250 staff are in sales. They market the firm's bench consultants (the **Hot List**) to vendors and clients, log submissions, and push candidates through interviews to placement.
- **Supporting staff:**
  - location ops and in-charge (about 40), who run facilities, utilities, bills and companies
  - HR, accounts and immigration, who handle paperwork, BGC, employees, invoices and payments, and work authorization
  - interview coaches and coordinators
  - leadership (associate director, CEO), who read dashboards, performance and reports
  - org admins, who manage users and access
- **External:**
  - job applicants on the careers portal (`/portal`)
  - interviewees filling a single-use feedback link (`/feedback/<token>`)
- **Locations:** the US (Eastern and Central) and India. Timestamps are stored in UTC and shown in the user's zone; interview times are also shown in EST.

## Product Purpose
Eureka is one system of record that replaces the firm's Sales, interview and placement Google Sheets and the placement Google Form. It covers candidates, submissions, interviews, placements, paperwork, employees, payments, training, facilities, files and chat, with each role seeing only what its position allows. Success means recruiters find and move candidates faster than they could in the sheets, and nothing sensitive leaks across teams.

## Positioning
- **One record per person.** The whole bench-sales loop (hot list → submission → interview rounds → placement → paperwork and BGC → employee → payments) lives on one person record.
- **Scoped access, enforced twice.** Role and hierarchy scoping is checked in the API and again by Postgres row-level security. Fields are masked: for example, phone numbers show only to the candidate's owners.
- **Fit to this firm's process.** It is built for this firm's own bench-sales workflow, not as a generic applicant tracking system.

## Operating Context
- **Devices:** desktop all day, on large monitors in the office or at home. Phones are used for quick lookups and notifications.
- **Work patterns:**
  - Dense, repeated, table-driven work: filtering the Hot List, bulk status and priority changes, logging submissions, scheduling interviews.
  - Back office works through queues: the paperwork checklist, BGC, invoices.
  - Leadership reads period dashboards.
- **Team working:** teams are organized by lead, manager, associate director and location (for example Dallas and Austin).
- **Users came from Google Sheets.** Sheet habits (scan, filter, bulk edit) are the baseline expectation.
- **Sign-in:** Google Workspace SSO with 2-step verification in production. Password sign-in exists only in staging and local environments.

## Capabilities and Constraints
- Stack: React + Vite, with a single `styles.css` plus area CSS. There is no UI framework, and new dependencies need a clear justification.
- Navigation is permission-aware (`nav.ts` controls only what is shown; the API decides access). Records are addressed at `/<screen>/<id>`.
- Light and dark themes both ship.
- Non-goals: payroll and accounting computation, e-signature, job-board integrations, native mobile apps.
- Terminology: Hot List, bench, submission, round, placement, BGC, paperwork checklist, priority P1–P3, "Open to all teams", guest house, in person.

## Brand Commitments
- The name **Eureka** is fixed.
- The mark, colours and typography are **open for replacement**. The user chose a full rebrand on 2026-11-05.
- The rebrand covers the staff app, the applicant portal and the public feedback form: one identity everywhere.

## Evidence on Hand
- All repository data is fictional (seeded candidates "CandN Test", teams "Team Rohit", "Team Anjali" and "Team Vikram", and so on).
- There are no real customer logos, testimonials, metrics or photography. **Do not fabricate any**, including the KPI and funnel art on the login screen.
- The UX audit and baseline screenshots are in `docs/ux-audit/`.

## Product Principles
1. **Scan speed beats decoration.** Users arrive from spreadsheets and judge the tool by how fast a filtered list appears.
2. **Every record is one click from its neighbours** (candidate ↔ submission ↔ interview ↔ placement).
3. **Show the next action before the facts** on every record.
4. **Masking and scope are visible and honest.** Never imply access the user does not have.
5. **Desktop density first, phone for checking.** Mobile is a distinct, lighter experience, not a shrunken desktop.

## Accessibility & Inclusion
WCAG 2.2 AA is the target. Users work long sessions across light and dark themes. Keyboard use matters for power users: `/` focuses search and Ctrl/Cmd+K opens Quick jump.

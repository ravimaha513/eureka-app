---
name: eureka-e2e
description: Write or fix Playwright end-to-end journeys in apps/web/e2e. Use when adding a browser test for a Eureka screen, when an e2e spec fails or is flaky, or when the user asks to "test the UI flow" / "add an e2e".
---

# Eureka Playwright journeys

Specs: `apps/web/e2e/<area>.spec.ts`. Helpers: `apps/web/e2e/support.ts` (`login`, `screen`,
`uniq`, `localDay`, …) — read its exports before writing new helpers.

## Setup

1. Stack must be running and **freshly seeded**: `pnpm local` (Docker PG :55432, API :3000,
   web :5173, `AUTH_MODE=dev`, dev step-up switch on).
2. Test users: `docs/TEST-USERS.md` (e.g. `locD@eureka.example` = Dallas Location Ops Admin).
3. Run: `pnpm --filter @eureka/web e2e e2e/<area>.spec.ts 2>&1 | tail -40`. Not concurrently
   with the API suite.

## Selector rules

- **Dropdowns**: labels wrap their `<select>`, so use
  `page.getByRole("combobox", { name: "Status", exact: true })` — never `getByLabel(..., { exact: true })`.
- Prefer roles + accessible names: `getByRole("button", { name, exact: true })`,
  `getByRole("dialog", { name: "… details" })`, `getByRole("region", { name: "… List" })`.
- No CSS/XPath selectors, no `nth()` unless order is the point.
- Scope to a region/dialog before querying inside it.

## Independence

- Every journey creates its own data with `uniq(...)` names; never depend on another spec's rows
  or on run order. Rely on dev-seed baseline only (documented at top of spec).
- Use `expect(...).toBeVisible()` / web-first assertions, never fixed sleeps.
- Long journeys: `test.setTimeout(90_000)`.

## Doc comment

Start each spec with a block comment: which role, what journey, which seed rows it relies on,
which dev switches it needs (see `facilities.spec.ts`).

## Flaky?

Check: missing `exact: true`, a name that collides with seed data, waiting on network instead of
UI state, step-up dialogs. Fix the cause; don't add retries or skip the test.

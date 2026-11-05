---
name: eureka-security-gate
description: Independent security review of a Eureka change before merge — authz, RLS, definer functions, PII in events, mass assignment, least privilege. Use before merging anything touching db/, packages/shared/src/authz, auth/identity, documents, payments, portal, or any new write endpoint; or when the user says "security review", "is this safe", "gate this PR".
---

# Eureka security gate

`docs/HANDOFF.md` requires an **independent** review of every security-relevant change. Don't
grade your own work from memory: spawn a fresh reviewer agent (no conversation context) and give
it the diff and this checklist, not your conclusions.

## Run

1. `git fetch origin main && git diff origin/main...HEAD --stat` — decide if it is
   security-relevant (any of: `db/**`, `catalog.ts`, `platform/auth*`, `modules/identity`,
   `modules/portal`, documents/datahub/payments, new POST/PUT/PATCH/DELETE routes, worker jobs).
2. Spawn a reviewer agent with: the diff (`git diff origin/main...HEAD`), `CLAUDE.md` rules
   section, and the checklist below. Ask for `path:line: severity: problem. fix.` lines and a
   verdict.
3. Verify each finding yourself against the code before acting; drop ones that don't hold.
4. Fix blockers, re-run tests, re-run the gate on the new diff.

## Checklist

**Access control**
- [ ] API: `@RequirePermission` on every route; read-before-write: 404 when not visible,
      403 when visible but not allowed. No id enumeration via different errors.
- [ ] DB re-checks permission **and** scope in the SECURITY DEFINER function (rule 6).
- [ ] NULL-safe `IF` everywhere (rule 1) — a NULL `has_perm` must deny.
- [ ] Function hardening: `REVOKE ALL FROM PUBLIC`, pinned `search_path`, EXECUTE to one role (rule 2).
- [ ] RLS forced on new tables; no per-row definer calls (rule 3).
- [ ] Catalog: `org_admin` gets no business permission; restricted/org-sensitive roles need a
      second approver; worker cannot become API role (rule 7).

**Data integrity**
- [ ] Strict zod schemas; server-managed columns guarded in DB (rule 4); mass-assignment case exists.
- [ ] Optimistic concurrency (If-Match / version) on edits of shared records.
- [ ] Race-free check-then-write (lock or unique constraint).

**Data exposure**
- [ ] No rates, phones, emails, free text, recording links in `audit_event` / `outbox_event` (rule 5).
- [ ] Responses don't leak fields beyond the caller's permission (restricted documents, rates).
- [ ] File downloads: Content-Disposition from server-derived names only; scan/quarantine respected.
- [ ] Errors/logs don't echo secrets or PII.

**Ops**
- [ ] Migration applies as non-superuser.
- [ ] Tests cover deny paths (404/403/422) not just the happy path.

Also available: the built-in `security-review` skill for a general pass; this gate adds the
Eureka-specific rules.

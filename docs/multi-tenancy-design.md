# Multi-tenancy and white-label design

Status: Proposed · Date: 2026-11-06

## 1. Goal

Sell Eureka to other staffing companies as a B2B product, branded as their own
(white-label). Each customer ("tenant") must:

- see only its own data, provably;
- sign in with its own identity provider;
- see its own name, logo, colors and domain;
- configure the business rules that differ between companies (time zone,
  currency, statuses, required documents, lookups) without a code change.

Non-goals for the first release: self-serve sign-up, a public marketplace,
per-tenant code customization.

## 2. Where we are today

Eureka is single-tenant by construction. Nothing in the schema, API or shared
package knows about a tenant.

| Area | Current state | Tenant blocker |
|---|---|---|
| Database | ~128 tables, RLS policies in ~66 migrations, ~99 function files in `db/functions/` | No `tenant_id`; RLS keys only on `eureka.user_id` (`apps/api/src/platform/db.service.ts`) |
| Sign-in | Google OIDC, one `GOOGLE_HOSTED_DOMAIN` (`platform/oidc.service.ts`), optional password login | One domain, no SAML, no generic OIDC, no tenant routing |
| Authz | Roles, permissions and scope grants compiled into `packages/shared/src/authz/catalog.ts` (17 roles, staffing-specific) | Same roles for every customer |
| Storage | One `DOCUMENTS_BUCKET`, keys `clean|restricted/documents/<id>` (`platform/storage/content.ts`) | No tenant prefix |
| Mail | One `PORTAL_FROM_EMAIL` via SES | No per-tenant sender/domain |
| Branding | CSS tokens already in `apps/web/src/styles.css` (`--brand`, `--pri`, `--side-bg`, …); name and logo compiled in | Not loaded at runtime |
| Hardcoded rules | e.g. `'America/New_York'` in `modules/payments/payments.service.ts` | Must become tenant settings |
| Infra | Terragrunt `infra/modules/stack` (app, database, edge, kms, storage); `infra/live/{staging,production}/env.hcl` hold domain, hosted domain, region, DB size | Already a one-stack-per-environment pattern |

## 3. Options

### Option A — Silo: one stack per tenant

Each tenant gets its own copy of `infra/modules/stack`: its own database, API/worker
service, bucket, KMS key, SES identity and domain. The application stays
single-tenant inside; "tenant" is a deployment.

- Pros: no schema rewrite; isolation is physical, which is easy to explain in
  security reviews; per-tenant region, backup, key and maintenance window;
  a bug cannot leak data across tenants.
- Cons: fixed cost per tenant (RDS + ECS + edge); migrations and deploys run N
  times; fleet operations need tooling. Fine up to roughly 10–30 tenants.
- Effort: about 3–6 weeks.

### Option B — Pooled: shared database, `tenant_id` everywhere

One stack, one database; every row carries `tenant_id` and every policy and
definer function filters on it.

- Pros: lowest cost per tenant; one deploy; scales to hundreds of tenants.
- Cons: touches every table, policy and function; one missed predicate leaks
  data between customers; needs a cross-tenant test suite and a security review.
- Effort: about 3–6 months.

### Option C — Hybrid (later)

Pooled for small tenants, silo for enterprise tenants that require dedicated
infrastructure. Only worth it once both A and B exist.

## 4. Decision

**Start with Option A (silo).** Build the tenant-agnostic pieces (section 5)
first because they are needed under every option. Revisit Option B when the
fleet passes ~20 tenants or per-tenant cost becomes material (section 8).

Reasons: the stack module already exists; isolation is the first question every
B2B buyer asks; the existing security model (RLS rules 1–8 in `CLAUDE.md`)
stays untouched; we learn which settings tenants actually change before baking
a pooled schema around them.

## 5. Work common to every option

### 5.1 Tenant settings

New table `eureka.tenant_settings` (single row in a silo; keyed by `tenant_id`
under Option B). Written only through a SECURITY DEFINER function gated by
`org_admin`; read by the API at startup and cached.

| Setting | Replaces |
|---|---|
| `display_name`, `product_name` | Hardcoded "Eureka" |
| `time_zone` (IANA) | `'America/New_York'` literals |
| `currency`, `locale` | Implicit USD / en-US |
| `support_email`, `mail_from` | `PORTAL_FROM_EMAIL` |
| `branding` (JSON: logo/favicon asset ids, color tokens) | Compiled CSS and logo |
| Feature flags (e.g. immigration, payments, portal, calendar) | Always-on modules |

Audit setting changes as keys changed only (rule 5: no free text in audit).

### 5.2 Runtime branding

- `GET /api/v1/branding` — public, cacheable, returns name, logo URLs and color
  tokens. No PII.
- Web app fetches it before first render and writes the tokens onto `:root`;
  the existing CSS variables in `styles.css` make this mostly a data change.
- Logos stored in the documents bucket under a `branding/` prefix, served via
  signed or public-read URL.
- Validate colors server-side (hex only) and check contrast against
  `--on-pri` / `--text` so a tenant cannot make the UI unreadable.
- Email templates read `display_name`, logo and `mail_from` from settings.

### 5.3 Identity

- Add generic OIDC (Okta, Azure AD/Entra, Auth0) alongside Google: issuer,
  client id/secret, allowed email domains as settings, not env vars.
- Add SAML 2.0 for enterprise buyers (signed assertions, pinned IdP certificate).
- Keep `not_provisioned` behavior: users must exist in Eureka before sign-in;
  optional SCIM provisioning later.
- Optional per-tenant MFA / step-up requirements reuse `platform/step-up.ts`.

### 5.4 Configurable workflow

Audit hardcoded staffing assumptions: statuses, required paperwork, lookups,
work-authorization types, hotlist rules. Move what differs between companies
into lookups or settings. Keep the role catalog in code for the first release;
offer optional role renaming via `ROLE_LABELS` overrides in settings.

### 5.5 Tenant lifecycle

- Provision: create stack → run migrations → seed `tenant_settings` → create
  first `org_admin` and send invite.
- Suspend: disable sign-in, keep data.
- Export: full data export (CSV/JSON + documents) on request.
- Delete: destroy stack after retention window; record certificate of deletion.

### 5.6 Commercial and compliance

- Billing (e.g. Stripe) with seat counts; seat limit enforced at user creation.
- SOC 2 Type II, annual pen test, subprocessor list (AWS, Google, SES, …), DPA,
  SLA and public status page.
- Support access: time-boxed, audited, step-up-protected staff access into a
  tenant, visible to the tenant's admins.
- Legal: confirm IP ownership and licensing before selling.

## 6. Option A implementation plan

### 6.1 Infrastructure

- New `infra/live/tenants/<slug>/env.hcl` per tenant, same shape as
  `infra/live/production/env.hcl` (region, `domain_name`, `google_hosted_domain`
  or IdP settings, `db_instance_class`).
- Custom domains: tenant points a CNAME at its stack; ACM certificate per
  domain via the edge module. Default `<slug>.<our-domain>` until then.
- Per-tenant SES identity (tenant verifies DKIM records) or a shared sending
  domain with tenant display name.
- `deploy.yml`: matrix over tenants; deploy staging first, then tenants in
  waves (canary tenant → rest). Migration failure stops the wave.
- Shared container image; every tenant runs the same version. No per-tenant
  forks.

### 6.2 Fleet operations

- Tenant registry (small control-plane table or a repo file) listing slug,
  region, version, contact, plan.
- Fleet scripts: run migration status, health check and version report across
  all tenants.
- Observability: tag logs and metrics with `tenant` so one dashboard covers the
  fleet; per-tenant alerts routed to on-call.
- Backups and `infra/scripts/restore-drill.sh` run per tenant.

### 6.3 Cost

Smallest viable stack is roughly one small RDS instance, one ECS service and
edge resources per tenant. Price the plan to cover this plus support.

## 7. Option B sketch (for later)

Recorded so Option A work does not block it.

1. `eureka.tenant` table; `tenant_id uuid NOT NULL` on every table, foreign keys
   and unique indexes extended to include `tenant_id`.
2. API sets `eureka.tenant_id` next to `eureka.user_id` in `db.service.ts`,
   resolved from host name or IdP at sign-in; sessions bound to one tenant.
3. Every RLS policy adds `tenant_id = authz.current_tenant()` (InitPlan form,
   rule 3). Every definer function re-checks tenant before permission and scope
   (rule 6). BEFORE INSERT guards set `tenant_id` server-side (rule 4).
4. Storage keys prefixed `tenants/<id>/`; outbox, worker jobs, idempotency keys,
   rate limits, audit events, imports, reports carry `tenant_id`.
5. Role catalog becomes per-tenant data, or stays global with per-tenant labels.
6. Cross-tenant isolation suite: for every endpoint and table, a user in tenant
   A gets 404/empty for tenant B rows (pattern like the mass-assignment cases).
7. Migration path from silos: export each silo database, stamp `tenant_id`,
   import into the pooled database, verify row counts, cut over DNS.

Keeping new code tenant-ready now (no global singletons, settings read from
`tenant_settings`, storage keys built in one helper) lowers the cost of this
later.

## 8. When to revisit

Move toward Option B or C when any of:

- more than ~20 tenants, or fleet deploys take too long;
- infrastructure cost per tenant exceeds an agreed share of plan price;
- sales needs a low-priced tier that cannot carry a dedicated stack.

## 9. Milestones

| # | Milestone | Scope | Estimate |
|---|---|---|---|
| M1 | Settings + branding | 5.1, 5.2, remove hardcoded time zone/currency | 1–2 weeks |
| M2 | Identity | Generic OIDC, SAML | 1–2 weeks |
| M3 | Tenant stacks | 6.1 infra, deploy matrix, custom domains, SES | 1–2 weeks |
| M4 | Pilot | One or two pilot tenants, fleet scripts, runbooks | 1 week + pilot period |
| M5 | Commercial | Billing, seat limits, support access, DPA, SOC 2 kickoff | parallel |

## 10. Open questions

1. Which identity providers do the first prospects use?
2. Do prospects require data residency outside us-east-2?
3. Which modules are core vs. paid add-ons (immigration, payments, portal)?
4. Is per-tenant role customization needed for the first customers, or are
   label overrides enough?
5. Who owns tenant onboarding and support?
6. IP and licensing: is Eureka free to sell outside the current company?

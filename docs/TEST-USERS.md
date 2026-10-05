# Test users and sign-in

Three ways to sign in, by environment. Passwords below are for **local** only; staging passwords are
set by admins and are never written in the repo.

| Environment | Sign-in |
|---|---|
| Production | Google Workspace SSO + 2-step verification only. Password sign-in is refused by the API config, Terraform and the database. |
| Staging | Google SSO, plus email + password for test users (`password_login = "on"` in `infra/live/staging/env.hcl`). |
| Local (`./scripts/local-dev.sh`) | Email + password, plus the dev picker. |

## Local accounts

`pnpm db:seed` gives every fictional user the password **`Eureka-dev-1`** (override with `DEV_PASSWORD`).
Sign in with the email and that password. These accounts exist only in your local database.

| Role | Email |
|---|---|
| `ceo` | `ceo@eureka.example` |
| `offshore_manager` | `om@eureka.example` |
| `assoc_director` | `ad@eureka.example` |
| `manager` | `m1@eureka.example`, `m2@eureka.example` |
| `lead` | `l1@eureka.example`, `l2@eureka.example`, `l3@eureka.example` |
| `recruiter` | `r1a@eureka.example`, `r1b@eureka.example`, `r2a@eureka.example`, `r3a@eureka.example` |
| `interview_coach` | `coach@eureka.example` |
| `location_ops_admin` | `locD@eureka.example` (Dallas), `opsA@eureka.example` (Austin) |
| `location_incharge` | `locA@eureka.example` |
| `hr` | `hr@eureka.example` |
| `accounts` | `acct@eureka.example` |
| `immigration` | `imm@eureka.example` |
| `org_admin` | `admin@eureka.example`, `admin2@eureka.example` |

## Staging accounts

No shared passwords exist. To create a test user:

1. **Org admin** opens Users & Access, New user, enters any email (the domain check is lifted while password
   sign-in is on) and a temporary password (10 to 72 characters, a letter and a number). Existing users get
   "Set password". Then grant roles as usual.
2. The user signs in with email and temporary password and is forced to choose their own before anything else.
3. **Restricted roles** (`org_admin`, `hr`, `accounts`, `immigration`, `location_ops_admin`): the screen refuses
   to set their password (it would bypass the second approver). Whoever holds the database credentials runs,
   as a one-off task on the migrate task definition:

   ```bash
   EUREKA_ENVIRONMENT=staging EUREKA_NEW_PASSWORD='<temporary>' node dist/db/set-password.js --email hr@example.com
   ```

   Locally: `EUREKA_ENVIRONMENT=local MIGRATION_DATABASE_URL=... pnpm --filter @eureka/api exec tsx src/db/set-password.ts --email hr@eureka.example`
   (prints a generated password once when run in a terminal).

## How it is protected

- Passwords are bcrypt-hashed (pgcrypto, cost 12, per-password salt) and verified **inside Postgres**
  (`authz.password_login`); the API never sees a hash and `authz.user_credential` is readable only by `authz_definer`.
- 5 wrong passwords lock the account for 15 minutes; every success and failure is audited without the password.
- Admin-set passwords are temporary (forced change). A new password signs the user out everywhere.
- Restricted documents and reveals ask for the password again (step-up, 10 minutes).
- Three independent switches must all say "staging or local": `PASSWORD_LOGIN` (API refuses to start otherwise),
  `password_login` in Terraform (precondition fails in production), and the database policy `password_login`
  (written by `migrate` only when `EUREKA_ENVIRONMENT` is staging or local; deleted everywhere else).
- Admins can sign in as users they set a password for, so on staging treat org admins as able to act as any non-restricted user.
- `AUTH_TEST_EMAILS` (exact emails, staging/local) additionally lets listed outside Google accounts through the Google flow.

# Eureka infrastructure (AWS)

Terraform + Terragrunt, following the conventions in `ravimaha513/spokenly`
(`deployment/terraform`): one AWS account (`637423353261`), production in
`us-east-1`, staging in `us-east-2`, S3 remote state, default tags.

Two deliberate differences from spokenly:

| | spokenly | eureka |
|---|---|---|
| CI credentials | long-lived `AWS_ACCESS_KEY_ID` secrets | GitHub OIDC roles, no keys stored anywhere |
| State locking | DynamoDB table | S3-native lockfile (Terraform ≥ 1.10) |
| Always-on environments | staging + production | production only; staging is created on demand |
| Egress / load balancing | NAT + ALB | public-IP tasks + API Gateway HTTP API (no NAT, no ALB) |

## Layout

```
infra/
  bootstrap/            one-time: state bucket + GitHub OIDC deploy roles (local state)
  terragrunt.hcl        root: remote state, providers, default tags
  live/staging/         env.hcl  (us-east-2, small, Spot, audit lock GOVERNANCE)
  live/production/      env.hcl  (us-east-1, single-AZ db.t4g.micro, audit lock COMPLIANCE 3y)
  modules/stack/        the whole environment
    main.tf       VPC, public/private subnets, S3 gateway endpoint, flow logs (no NAT)
    kms.tf        keys: data, restricted
    database.tf   RDS PostgreSQL 16 (TLS only, managed master secret), SSM parameters
    storage.tf    S3: documents (quarantine -> clean/restricted, GuardDuty scan), audit (Object Lock), web, logs
    app.tf        ECR, ECS Fargate ARM64 (api, worker, migrate), API Gateway HTTP API + VPC link + Cloud Map
    edge.tf       CloudFront + WAF (5 rules), SPA rewrite function, ACM, Route 53, security headers
  .checkov.yaml   accepted Checkov skips, each with a reason
```

## What runs where

```
Browser ──HTTPS──> CloudFront (WAF, security headers)
                     ├── /*      -> viewer-request function (extensionless paths -> /index.html)
                     │              -> S3 web bucket (OAC)
                     └── /api/*  -> API Gateway HTTP API (throttled) -> VPC link -> Cloud Map
                                     └── ECS Fargate "api" (public subnet, "tasks" SG: inbound only from the VPC link;
                                         rejects requests without CloudFront's X-Origin-Verify secret)
                                            └── RDS PostgreSQL (private subnet, no internet route; TLS verify-full, RLS)
ECS "migrate" task: runs before each rollout as the RDS master user ("jobs" SG: no inbound at all)
ECS "worker":       desired_count 0 until turned on ("jobs" SG); nightly audit export -> audit bucket
```

Notes:

- The only request the API accepts without the origin secret is `GET /api/health`
  from loopback (the ECS container health check). The same path through API
  Gateway needs the secret like everything else.
- `ORIGIN_VERIFY_SECRET` accepts a comma-separated list (each entry 32+
  characters), so a rotation can be staged without downtime: API gets
  `new,old` and rolls, CloudFront switches its header to `new`, API gets `new`
  alone. Both values are Terraform-managed today (`random_password.origin_secret`
  feeds CloudFront and `/eureka/<env>/app/origin_secret`), so make those steps
  as Terraform changes rather than by hand.
- API Gateway access logs record `$context.identity.sourceIp`, which is a
  CloudFront edge address, not the client. Use WAF sampled requests (or, later,
  the `CloudFront-Viewer-Address` header in app logs) for client IPs.
- Each process opens at most `DB_POOL_MAX` (5 in AWS) database connections:
  db.t4g.micro allows roughly 80–110 and a rolling deploy can briefly run up to
  6 API tasks plus the worker.
- On SIGTERM the API keeps serving for 15 s (`DRAIN_SECONDS`) so API Gateway
  stops routing to it, then closes; the container `stopTimeout` is 30 s.

## Cost

Target: **about $30/month for production**, versus roughly $545/month for the
first version of this stack (two always-on environments with NAT gateways,
interface endpoints, ALBs and a Multi-AZ db.t4g.medium). us-east-1 on-demand
prices, tens of users, under 1M requests/month:

| Item | Monthly |
|---|---|
| RDS PostgreSQL db.t4g.micro, single-AZ, 20 GB gp3, 14-day PITR | ~$14 |
| Fargate ARM64 API task, 0.25 vCPU / 0.5 GB, on-demand | ~$7 |
| Public IPv4 address for that task | ~$3.65 |
| KMS keys (data, restricted) | $2 |
| Cloud Map namespace (private hosted zone) + RDS master secret | ~$1 |
| API Gateway HTTP API ($1 per million requests) | <$1 |
| CloudFront + WAF on the flat-rate **Free** plan (1M requests, 100 GB) | $0 |
| S3, ECR, CloudWatch logs, flow logs | ~$1–2 |
| **Total** | **~$30** |

If the distribution is not enrolled in the CloudFront Free plan, WAF adds about
$10/month (web ACL + 5 rules). Once it is enrolled, the web ACL cannot be
detached from the distribution, so `aws_wafv2_web_acl.main` has
`prevent_destroy`: rule changes apply in place, but a change that would replace
or delete the web ACL fails at plan time. To remove it, cancel the plan in the
CloudFront console first, then lift the guard.

What the table does not include (usually small, but not fixed):

- **Public IPv4 per running task** ($0.005/hour each): the table assumes one
  API task. A rolling deploy briefly doubles it, autoscaling adds up to two
  more, and the worker (Phase 2) and each migrate run add one while running.
- **RDS CPU credits**: t4g instances run in *unlimited* mode; sustained CPU
  above the baseline bills surplus credits (about $0.075 per vCPU-hour).
- **GuardDuty Malware Protection for S3**: billed per GB scanned and per object
  evaluated; negligible for résumé-sized files at tens of users, but it grows
  with upload volume.
- **Route 53 hosted zone**: $0.50/month if a new zone is created for the
  custom domain (none if the zone already exists).
- **Abuse**: the API Gateway endpoint is public, so a direct flood is billed
  (see "Known risks" below).

What was removed and why:

| Removed | Saved/month | Replacement |
|---|---|---|
| Always-on staging | ~$200 | CI tests against PostgreSQL on every push; create staging on demand |
| NAT gateways | $33 each | API tasks in public subnets with a public IP; inbound only from the VPC link |
| 6 interface VPC endpoints × 2 AZs | ~$88 | Tasks reach AWS APIs over the internet (TLS, IAM) |
| Application Load Balancer | ~$30 | API Gateway HTTP API + VPC link + Cloud Map |
| Multi-AZ db.t4g.medium | ~$90 | Single-AZ db.t4g.micro with point-in-time restore |
| Second API task, 0.5 vCPU / 1 GB | ~$22 | One 0.25 vCPU / 0.5 GB task; autoscaling to 3 on CPU |
| Secrets Manager (4 secrets) | ~$1.60 | SSM Parameter Store SecureString (free tier) |
| KMS keys for logs, fields, WAF logs | $3 | Default log encryption; field encryption uses the restricted key |
| Container Insights, Enhanced Monitoring, Performance Insights, WAF logs | ~$10 | Basic metrics, API Gateway access logs, Postgres slow-query log |

Knobs for later, in `live/production/env.hcl`: `db_multi_az = true` (+~$14),
`api_desired_count = 2` (+~$11), `db_instance_class = "db.t4g.small"` (+~$12).
Cheaper still: `use_fargate_spot = true` (-~$5, occasional 2-minute
interruptions) or a 1-year RDS reservation (about 30% off).

Staging, when you need it, costs about $25–35/month while it exists (billed
hourly): `cd infra/live/staging && terragrunt apply`, then `terragrunt destroy`.
The WAF web ACL has `prevent_destroy`, so a staging teardown first removes it
from state (`terragrunt state rm aws_wafv2_web_acl.main`), then deletes it in
the console after the distribution is gone. Never do this for production while
it is on a flat-rate plan.

## One-time setup (you run this, from a machine with admin AWS credentials)

1. **Bootstrap** (creates the state bucket and the two deploy roles):

   ```sh
   cd infra/bootstrap
   terraform init
   # If the account already has the GitHub OIDC provider (spokenly may have
   # created it), add: -var create_github_oidc_provider=false
   terraform apply
   ```

2. **GitHub repository settings** (`ravimaha513/eureka-app`):
   - Variables → `AWS_ACCOUNT_ID = 637423353261`
   - Environments → create `production` (restrict it to `main`; add yourself
     as a required reviewer if you want to approve each deploy) and `staging`.
   - No AWS secrets are needed.

3. **Decide the open values** in `live/production/env.hcl` (marked `TODO`):
   - `google_hosted_domain` (required): your Google Workspace domain. Only
     accounts in that domain can sign in. While it is empty, the first deploy
     still creates the network, database and migrate task and runs migrations
     (step 3 of the workflow), but the full apply (step 4) stops at plan time
     with a precondition error on `aws_ecs_task_definition.api`, so no API
     service is created and the deploy fails.
   - Hostname and hosted zone (optional): leave empty to use the
     `https://dxxxx.cloudfront.net` address until a real domain exists.
   - For staging later: `eureka.spokenly.click` is taken by spokenly staging;
     the default there is `eureka-staging.spokenly.click`.

4. **Google OAuth client** (Google Cloud console → APIs & Services → Credentials):
   - Type: Web application.
   - Authorized redirect URI: `https://<app host>/api/auth/callback`.
   - Terraform creates `/eureka/<env>/app/google_client_{id,secret}` with the
     placeholder value `set-me` and never overwrites them afterwards. The API
     refuses to start while either value is still `set-me` (config check), so
     on a first deploy without real values the API tasks exit on start, the
     service never becomes stable, and the workflow fails at "Wait for API
     service to stabilise" (the migrate step and the rest of the stack are
     already in place by then). The worker is at `desired_count = 0`, so it
     is not affected.
   - Easiest order: create just the parameters first, set them, then push:
     ```sh
     cd infra/live/production
     terragrunt apply -target=aws_ssm_parameter.google
     aws ssm put-parameter --overwrite --type SecureString --key-id alias/eureka-production-data \
       --name /eureka/production/app/google_client_id --value '<client id>'
     aws ssm put-parameter --overwrite --type SecureString --key-id alias/eureka-production-data \
       --name /eureka/production/app/google_client_secret --value '<client secret>'
     ```
   - If a deploy already ran with the placeholders, run the two `put-parameter`
     commands and then
     `aws ecs update-service --cluster eureka-production --service api --force-new-deployment`
     (or re-run the deploy workflow).

5. **CloudFront Free plan** (makes CloudFront and WAF $0): CloudFront console →
   the `eureka-production` distribution → Pricing plan → Free. The plan
   requires the dedicated web ACL Terraform already attaches (5 rules).
   Above 1M requests/month, move to the Pro plan ($15).

## Deploying

- **Production:** every push to `main` that passes CI runs `.github/workflows/deploy.yml`.
- **Staging** (only after creating it): Actions → deploy → Run workflow → `staging`.

The workflow, per environment:

1. `terragrunt apply -target=aws_ecr_repository.api`
2. Build the ARM64 image natively and push it, tagged with the git SHA (immutable tags, SBOM + provenance).
3. Targeted apply of the migrate task definition plus what it needs at run time
   but does not reference (cluster, public subnet routing, S3 endpoint, "jobs"
   security group rules, database ingress, execution role policies); on the
   first run this creates the network and database. Run it in the "jobs"
   security group and fail the deploy if it exits non-zero.
4. Full `terragrunt apply` with `image_tag = <sha>`; wait for the API service to be stable.
5. Build the web app, sync to S3 (hashed assets immutable, `index.html` no-cache), invalidate CloudFront.
6. Smoke test `GET /api/health`.

Migrations must be backward compatible with the running version
(expand → deploy → contract), because step 3 runs before the new API is live.

## Turning on the worker

The worker runs scheduled jobs from the `eureka.job_run` table (migrations 0016,
0020). Today that is **audit-export**: every day at 03:30 America/New_York it writes the
previous UTC day of `audit_event` to
`s3://<audit bucket>/audit/YYYY/MM/DD/audit-events.jsonl.gz` (gzip JSON Lines,
uploaded create-only with `If-None-Match: *` and `x-amz-checksum-sha256`; SSE-KMS
and Object Lock from the bucket defaults) and appends the SHA-256, row count and
seq range to `eureka.audit_export`.

- **Catch-up.** The due days come from the ledger, not a fixed look-back: every
  UTC day from the first exported day up to the latest due day that has no
  `audit_export` row, oldest first, at most `AUDIT_EXPORT_MAX_DAYS_PER_TICK`
  (default 7) per tick. After any downtime every missed day is exported.
- **One runner per day.** A task claims a (job, day) with a lease in `job_run`
  (`lease_until`, 2 minutes, renewed every 30 s while it works). A second task
  sees the live lease and moves on; if the holder dies, its lease expires and
  another task takes over. Renewals and the final status update are fenced on
  `attempts`, so a task that lost its lease aborts and cannot overwrite the new
  holder's result.
- **Retries.** A failed day waits `next_attempt_at`: 1 min, doubling per attempt,
  capped at 6 h. From the 8th failed attempt on, each failure logs
  `"msg":"job failed repeatedly","alert":true`. A retry after a failed ledger
  insert gets 412 from S3; the worker then compares the stored object's SHA-256
  (HeadObject) with its own and, if equal, only inserts the ledger row, so
  retries add no Object Lock versions. A different object under the key is an
  error (alert-worthy: investigate before anything else).
- **Behind.** When the latest exported day is more than one day before
  yesterday the worker logs `"msg":"audit export is behind","alert":true` (at
  most hourly). Put CloudWatch metric filters on `"alert":true`.
- **Integrity.** The database sets `job_run.started_at`/`finished_at`, rejects
  run keys in the future and refuses to mark an audit-export day succeeded
  without its `audit_export` row (migration 0020); the ledger is the evidence.

To turn it on, set `worker_desired_count = 1` in `infra/live/<env>/env.hcl` and
deploy (one task is enough; more are safe but idle). The worker needs
migrations 0016 and 0020 applied first, which the deploy's migrate step does.
Its task role can only `s3:PutObject` and `s3:GetObject` (used for HeadObject
after a 412) under `audit/*` in the audit bucket and `kms:GenerateDataKey` on
the data key through S3; its task definition gets `DATABASE_URL` (the
`eureka_worker` role) and `AUDIT_BUCKET`, nothing else. S3 calls time out
(5 s connect, 30 s request, 3 attempts). The audit bucket policy denies
uploads that name any encryption other than the data key (a missing header is
allowed, since the worker relies on the bucket default). On SIGTERM the worker
exits non-zero if a job was still running or the database pool did not close
in time. Logs are JSON lines in
`/eureka/<env>/worker`: look for `"msg":"job succeeded","job":"audit-export"`.
Check an export with:

```sh
aws s3api head-object --bucket <audit bucket> --key audit/YYYY/MM/DD/audit-events.jsonl.gz --checksum-mode ENABLED
# ChecksumSHA256 (base64) matches eureka.audit_export.sha256_hex (hex) for that day
```

## Launch checks

The MVP exit criteria (docs/implementation-plan.md) need three checks against a
running stack. None of them runs on push or pull request.

- **Load test (k6):** `loadtest/README.md`. 120 users over 50k fictional
  candidates; pass is p95 < 500 ms and < 1% errors.
- **ZAP baseline:** Actions → zap-baseline → Run workflow, with the URL of the
  stack (e.g. `https://eureka-staging.spokenly.click`). It spiders the site
  (plus the AJAX spider for the SPA) and runs ZAP's passive rules only, no
  attack payloads. `.zap/rules.tsv` sets each alert to FAIL (fails the job),
  WARN (reported) or IGNORE (noise such as cache and timestamp notices); the
  HTML/JSON report is attached to the run as `zap-baseline-report`. To accept
  a finding, change its line in the rules file with a reason in the commit.
  The scan is unauthenticated: it covers the web app shell, security headers,
  cookies and the API's unauthenticated answers.
- **Restore drill:** below.

## Restore drill

Goal: prove a backup can be turned into a working database within the RTO,
and measure how much data a restore would lose (RPO). Run it on staging first,
then on production before launch and after any change to the database setup;
the plan asks for a weekly check once live. A drill costs about one hour of a
db.t4g.micro (cents) and touches the live database only through describe calls.

Targets to confirm with Ravi (proposed): **RTO 2 hours, RPO 15 minutes.**
Automated backups give point-in-time restore to within about 5 minutes
(`backup_retention_period` days back); a snapshot restore loses everything since
that night's backup window (07:00–08:00 UTC).

### Automated: `infra/scripts/restore-drill.sh`

```sh
infra/scripts/restore-drill.sh staging                   # point-in-time (latest restorable time)
infra/scripts/restore-drill.sh production --snapshot latest
infra/scripts/restore-drill.sh staging --keep            # leave the copy up for inspection
```

It needs admin AWS credentials, `jq`, `node` and `terragrunt` (for the stack
outputs; or set `CLUSTER`, `TASK_FAMILY`, `SUBNETS`, `SECURITY_GROUP`). Steps:

1. Reads the source instance (`eureka-<env>`): subnet group, security group,
   parameter group and class, and its latest restorable time.
2. Restores into a **new** instance `eureka-<env>-drill-<UTC timestamp>`
   (point-in-time with `--use-latest-restorable-time`, or from a snapshot),
   private, single-AZ, tagged `purpose=restore-drill`. The copy is encrypted
   with the same KMS key and keeps the app and worker role passwords.
3. Waits until it is available (typically 10–30 minutes), then sets the copy's
   master password to the current value of the RDS-managed secret (RDS rotates
   it, so an older restore point can hold an older password).
4. Runs the restore check inside the VPC: a one-off task on the migrate task
   definition with the command `node dist/db/restore-check.js` and `DB_HOST`
   pointed at the copy. The check is read-only and fails when
   - any migration shipped in the image is not applied (`public.schema_migration`),
   - RLS is not enabled and forced on person, candidate, submission, interview,
     audit_event or placement,
   - the `eureka_app` role cannot log in, sees any candidate without a user
     context (RLS must fail closed), or sees none for a recruiter who has some.
   It prints one JSON line with row counts and the newest write.
5. Prints the report: RPO (drill start minus restore point), time to
   available, RTO (drill start to verified), and the check's exit code.
6. Deletes the copy (`--skip-final-snapshot --delete-automated-backups`) on
   exit, also on failure, unless `--keep`. It only ever deletes an
   identifier containing `-drill-`.

Record each run (date, environment, source, RPO, RTO, pass/fail) in the
operations log. A failed check or an RTO over target is a launch blocker.

### By hand (what to do in a real incident)

1. Pick the restore point: console → RDS → `eureka-<env>` → Actions → Restore
   to point in time (or Snapshots → Restore). New identifier, same subnet
   group `eureka-<env>`, security group `eureka-<env>-db`, parameter group
   `eureka-<env>-pg16`, not publicly accessible.
2. Verify it with the restore check (step 4 above).
3. Cut over: Terraform owns `aws_db_instance.main`, so the safest switch is to
   rename. Stop traffic (`aws ecs update-service --cluster eureka-<env> --service
   api --desired-count 0`), rename the broken instance out of the way
   (`aws rds modify-db-instance --db-instance-identifier eureka-<env>
   --new-db-instance-identifier eureka-<env>-old --apply-immediately`), rename
   the restored one to `eureka-<env>`, then re-run the deploy workflow: the SSM
   URLs point at the instance address, which follows the identifier. Expect
   `terragrunt plan` drift on settings the restore did not copy (backup
   retention, log exports, deletion protection); apply it.
4. Smoke test: `GET /api/health`, sign in, open the Hot List.
5. Keep the old instance until the incident review is done, then delete it with
   a final snapshot.

## Known risks

- **The API Gateway endpoint is public.** `https://<id>.execute-api.<region>.amazonaws.com`
  is reachable directly, bypassing CloudFront, and HTTP APIs cannot have a WAF
  web ACL. The app rejects such requests (origin secret, 403), but API Gateway
  still accepts and bills them, and they count against the stage throttle
  (burst 300, 100 requests/second), which is shared by every caller.
  - *Availability*: a sustained direct flood can exhaust that throttle, so
    real users coming through CloudFront get 429s for as long as it lasts.
  - *Cost ceiling*: at most 100 requests/second ≈ 260M requests/month ≈
    $260/month of API Gateway requests (about $1 per million), plus CloudWatch
    ingestion for the access log line of each request (about $0.50/GB).
  - *If it is abused*: move the origin behind something that is not publicly
    addressable. Either a CloudFront VPC origin to an internal ALB (about
    +$20/month; the ALB can then carry the WAF too), or a Lambda REQUEST
    authorizer on the route that checks the origin header, with authorizer
    caching keyed on that header so rejected floods are cheap and never reach
    the tasks.
- **Access logs show CloudFront, not clients.** See the notes under "What runs where".

## Local checks

```sh
cd infra/modules/stack && terraform init -backend=false && terraform validate
checkov -d infra --config-file infra/.checkov.yaml --framework terraform
```

## Secrets inventory

| Where | Created by | Contents | Read by |
|---|---|---|---|
| Secrets Manager: RDS managed master secret | RDS | master user/password (rotated by RDS) | migrate task only |
| SSM `/eureka/<env>/db/{app,worker}/{password,url}` | Terraform (random) | DB role credentials | api, worker, migrate |
| SSM `/eureka/<env>/app/session_secret` | Terraform (random) | session/CSRF HMAC key | api |
| SSM `/eureka/<env>/app/origin_secret` | Terraform (random) | CloudFront → API shared secret | CloudFront, api |
| SSM `/eureka/<env>/app/google_client_{id,secret}` | you | Google OAuth client | api |

All SSM values are SecureString encrypted with the `data` KMS key. Nothing from
spokenly's secrets or `.env` files is reused.

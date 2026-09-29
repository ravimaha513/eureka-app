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

The worker runs scheduled jobs from the `eureka.job_run` table (migration 0016).
Today that is **audit-export**: every day at 03:30 America/New_York it writes the
previous UTC day of `audit_event` to
`s3://<audit bucket>/audit/YYYY/MM/DD/audit-events.jsonl.gz` (gzip JSON Lines,
uploaded with `x-amz-checksum-sha256`, SSE-KMS and Object Lock from the bucket
defaults) and appends the SHA-256, row count and seq range to
`eureka.audit_export`. It catches up on the last 3 days after downtime; days
already exported are skipped, and two tasks never export the same day.

To turn it on, set `worker_desired_count = 1` in `infra/live/<env>/env.hcl` and
deploy (one task is enough; more are safe but idle). The worker needs migration
0016 applied first, which the deploy's migrate step does. Its task role can only
`s3:PutObject` under `audit/*` in the audit bucket and `kms:GenerateDataKey` on
the data key through S3; its task definition gets `DATABASE_URL` (the
`eureka_worker` role) and `AUDIT_BUCKET`, nothing else. Logs are JSON lines in
`/eureka/<env>/worker`: look for `"msg":"job succeeded","job":"audit-export"`.
Check an export with:

```sh
aws s3api head-object --bucket <audit bucket> --key audit/YYYY/MM/DD/audit-events.jsonl.gz --checksum-mode ENABLED
# ChecksumSHA256 (base64) matches eureka.audit_export.sha256_hex (hex) for that day
```

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

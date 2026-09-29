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
  live/production/      env.hcl  (us-east-1, Multi-AZ, audit lock COMPLIANCE 7y)
  modules/stack/        the whole environment
    main.tf       VPC, public/private subnets, S3 gateway endpoint, flow logs (no NAT)
    kms.tf        keys: data, restricted
    database.tf   RDS PostgreSQL 16 (TLS only, managed master secret), SSM parameters
    storage.tf    S3: documents (quarantine -> clean/restricted, GuardDuty scan), audit (Object Lock), web, logs
    app.tf        ECR, ECS Fargate ARM64 (api, worker, migrate), API Gateway HTTP API + VPC link + Cloud Map
    edge.tf       CloudFront + WAF (5 rules), ACM, Route 53, security headers
  .checkov.yaml   accepted Checkov skips, each with a reason
```

## What runs where

```
Browser ──HTTPS──> CloudFront (WAF, security headers)
                     ├── /*      -> S3 web bucket (OAC)
                     └── /api/*  -> API Gateway HTTP API (throttled) -> VPC link -> Cloud Map
                                     └── ECS Fargate "api" (public subnet, inbound only from the VPC link;
                                         rejects requests without CloudFront's X-Origin-Verify secret)
                                            └── RDS PostgreSQL (private subnet, no internet route; TLS verify-full, RLS)
ECS "migrate" task: runs before each rollout as the RDS master user
ECS "worker":       desired_count 0 until Phase 2
```

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
$10/month (web ACL + 5 rules).

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
     accounts in that domain can sign in.
   - Hostname and hosted zone (optional): leave empty to use the
     `https://dxxxx.cloudfront.net` address until a real domain exists.
   - For staging later: `eureka.spokenly.click` is taken by spokenly staging;
     the default there is `eureka-staging.spokenly.click`.

4. **Google OAuth client** (Google Cloud console → APIs & Services → Credentials):
   - Type: Web application.
   - Authorized redirect URI: `https://<app host>/api/auth/callback`.
   - After the first deploy creates the parameters, set the real values and
     restart the API:
     ```sh
     aws ssm put-parameter --overwrite --type SecureString --key-id alias/eureka-production-data \
       --name /eureka/production/app/google_client_id --value '<client id>'
     aws ssm put-parameter --overwrite --type SecureString --key-id alias/eureka-production-data \
       --name /eureka/production/app/google_client_secret --value '<client secret>'
     aws ecs update-service --cluster eureka-production --service api --force-new-deployment
     ```
   Until this is done the API fails its config check on start (by design).

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
3. Apply the migrate task definition, run it, and fail the deploy if it exits non-zero.
4. Full `terragrunt apply` with `image_tag = <sha>`; wait for the API service to be stable.
5. Build the web app, sync to S3 (hashed assets immutable, `index.html` no-cache), invalidate CloudFront.
6. Smoke test `GET /api/health`.

Migrations must be backward compatible with the running version
(expand → deploy → contract), because step 3 runs before the new API is live.

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
| SSM `/eureka/<env>/app/session_secret` | Terraform (random) | session/CSRF HMAC key | api, worker |
| SSM `/eureka/<env>/app/origin_secret` | Terraform (random) | CloudFront → API shared secret | CloudFront, api |
| SSM `/eureka/<env>/app/google_client_{id,secret}` | you | Google OAuth client | api, worker |

All SSM values are SecureString encrypted with the `data` KMS key. Nothing from
spokenly's secrets or `.env` files is reused.

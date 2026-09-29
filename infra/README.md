# Eureka infrastructure (AWS)

Terraform + Terragrunt, following the conventions in `ravimaha513/spokenly`
(`deployment/terraform`): one AWS account (`637423353261`), production in
`us-east-1`, staging in `us-east-2`, S3 remote state, default tags.

Two deliberate differences from spokenly:

| | spokenly | eureka |
|---|---|---|
| CI credentials | long-lived `AWS_ACCESS_KEY_ID` secrets | GitHub OIDC roles, no keys stored anywhere |
| State locking | DynamoDB table | S3-native lockfile (Terraform ≥ 1.10) |

## Layout

```
infra/
  bootstrap/            one-time: state bucket + GitHub OIDC deploy roles (local state)
  terragrunt.hcl        root: remote state, providers, default tags
  live/staging/         env.hcl  (us-east-2, small, Spot, audit lock GOVERNANCE)
  live/production/      env.hcl  (us-east-1, Multi-AZ, audit lock COMPLIANCE 7y)
  modules/stack/        the whole environment
    main.tf       VPC, private subnets, NAT, VPC endpoints, flow logs
    kms.tf        keys: data, restricted, field, logs
    database.tf   RDS PostgreSQL 16 (TLS only, managed master secret), role secrets
    storage.tf    S3: documents (quarantine -> clean/restricted, GuardDuty scan), audit (Object Lock), web, logs
    app.tf        ECR, ECS Fargate ARM64 (api, worker, migrate), ALB, autoscaling
    edge.tf       CloudFront + WAF, ACM, Route 53, security headers
  .checkov.yaml   accepted Checkov skips, each with a reason
```

## What runs where

```
Browser ──HTTPS──> CloudFront (WAF, security headers)
                     ├── /*      -> S3 web bucket (OAC)
                     └── /api/*  -> ALB (CloudFront prefix list + X-Origin-Verify header only)
                                     └── ECS Fargate "api" (private subnets)
                                            └── RDS PostgreSQL (TLS verify-full, RLS)
ECS "migrate" task: runs before each rollout as the RDS master user
ECS "worker":       desired_count 0 until Phase 2
```

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
   - Environments → create `staging` and `production`; on `production`, add
     yourself as a required reviewer and restrict it to the `main` branch.
   - No AWS secrets are needed.

3. **Decide the open values** in `live/*/env.hcl` (marked `TODO`):
   - Staging hostname. `eureka.spokenly.click` is taken by spokenly staging;
     the default here is `eureka-staging.spokenly.click`.
   - Production hostname and hosted zone (leave empty to use the CloudFront
     domain until a real domain exists).
   - `google_hosted_domain`: your Google Workspace domain. Only accounts in
     that domain can sign in.

4. **Google OAuth client** (Google Cloud console → APIs & Services → Credentials):
   - Type: Web application.
   - Authorized redirect URI: `https://<app host>/api/auth/callback`.
   - After the first deploy creates the secret, put the values into
     `eureka/<env>/app` in Secrets Manager (keys `GOOGLE_CLIENT_ID`,
     `GOOGLE_CLIENT_SECRET`), then redeploy the API service:
     ```sh
     aws ecs update-service --cluster eureka-<env> --service api --force-new-deployment
     ```
   Until this is done the API fails its config check on start (by design).

## Deploying

- **Staging:** every push to `main` that passes CI runs `.github/workflows/deploy.yml`.
- **Production:** Actions → deploy → Run workflow → `production` (needs approval).

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

| Secret | Created by | Contents | Read by |
|---|---|---|---|
| RDS managed master secret | RDS | master user/password (rotated by RDS) | migrate task only |
| `eureka/<env>/db/app` | Terraform (random) | `password`, `url` | api task |
| `eureka/<env>/db/worker` | Terraform (random) | `password`, `url` | worker task |
| `eureka/<env>/app` | Terraform; Google values set by you | `SESSION_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | api, worker |

Nothing from spokenly's secrets or `.env` files is reused.

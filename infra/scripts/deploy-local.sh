#!/usr/bin/env bash
# Manual deploy from a laptop, mirroring .github/workflows/deploy.yml.
# Usage: infra/scripts/deploy-local.sh [staging|production]   (default: staging)
# Needs: aws CLI with admin creds, terragrunt, terraform, docker (arm64 host), jq, pnpm.
set -euo pipefail

ENVIRONMENT="${1:-staging}"
case "$ENVIRONMENT" in
  staging) AWS_REGION=us-east-2 ;;
  production) AWS_REGION=us-east-1 ;;
  *) echo "usage: $0 [staging|production]" >&2; exit 2 ;;
esac
export AWS_REGION AWS_DEFAULT_REGION="$AWS_REGION" TG_NON_INTERACTIVE=true

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
LIVE="$ROOT/infra/live/$ENVIRONMENT"
IMAGE_TAG="$(git -C "$ROOT" rev-parse HEAD)"
if [ -n "$(git -C "$ROOT" status --porcelain --untracked-files=no)" ]; then
  IMAGE_TAG="$IMAGE_TAG-dirty-$(date +%s)" # tags are immutable; never reuse a SHA for different content
fi
export TF_VAR_image_tag="$IMAGE_TAG"

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
REGISTRY="$ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com"
IMAGE="$REGISTRY/eureka-$ENVIRONMENT-api:$IMAGE_TAG"

echo ">> $ENVIRONMENT / $AWS_REGION / account $ACCOUNT_ID / tag $IMAGE_TAG"
read -r -p "Deploy to AWS now? [y/N] " ok
[ "$ok" = "y" ] || exit 1

cd "$LIVE"

echo ">> 1. ECR repository"
terragrunt apply -auto-approve -input=false -target=aws_ecr_repository.api

echo ">> 2. Build and push image"
aws ecr get-login-password | docker login --username AWS --password-stdin "$REGISTRY"
docker build --platform linux/arm64 -t "$IMAGE" "$ROOT"
docker push "$IMAGE"

echo ">> 3. Migrate task definition"
terragrunt apply -auto-approve -input=false \
  -target=aws_ecs_task_definition.migrate \
  -target=aws_ecs_cluster.main \
  -target=aws_route_table_association.public \
  -target=aws_vpc_endpoint.s3 \
  -target=aws_vpc_security_group_egress_rule.jobs_https \
  -target=aws_vpc_security_group_egress_rule.jobs_db \
  -target=aws_vpc_security_group_ingress_rule.db_from_jobs \
  -target=aws_iam_role_policy_attachment.execution \
  -target=aws_iam_role_policy.execution_secrets

OUT="$(mktemp)"
terragrunt output -json > "$OUT"
CLUSTER=$(jq -r .ecs_cluster.value "$OUT")
TD=$(jq -r .migrate_task_definition.value "$OUT")
SUBNETS=$(jq -r '.public_subnet_ids.value | join(",")' "$OUT")
SG=$(jq -r .jobs_security_group_id.value "$OUT")

echo ">> 4. Run migrations"
TASK=$(aws ecs run-task --cluster "$CLUSTER" --task-definition "$TD" --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[$SUBNETS],securityGroups=[$SG],assignPublicIp=ENABLED}" \
  --started-by "local-$USER" --query 'tasks[0].taskArn' --output text)
echo "migrate task: $TASK"
aws ecs wait tasks-stopped --cluster "$CLUSTER" --tasks "$TASK"
CODE=$(aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$TASK" --query 'tasks[0].containers[0].exitCode' --output text)
echo "exit code: $CODE"
test "$CODE" = "0"

echo ">> 5. Apply full stack"
terragrunt apply -auto-approve -input=false
terragrunt output -json > "$OUT"
aws ecs wait services-stable --cluster "$(jq -r .ecs_cluster.value "$OUT")" --services "$(jq -r .api_service.value "$OUT")"

echo ">> 6. Publish web"
cd "$ROOT"
pnpm install --frozen-lockfile --filter @eureka/web...
pnpm --filter @eureka/web build
BUCKET=$(jq -r .web_bucket.value "$OUT")
DIST=$(jq -r .cloudfront_distribution_id.value "$OUT")
aws s3 sync apps/web/dist "s3://$BUCKET" --delete --exclude index.html \
  --cache-control "public,max-age=31536000,immutable"
aws s3 cp apps/web/dist/index.html "s3://$BUCKET/index.html" \
  --cache-control "no-cache,no-store,must-revalidate"
aws cloudfront create-invalidation --distribution-id "$DIST" --paths "/index.html" "/"

echo ">> 7. Smoke test"
URL=$(jq -r .app_url.value "$OUT")
for _ in $(seq 1 10); do
  curl -fsS "$URL/api/health" && echo && echo "OK $URL" && exit 0
  sleep 15
done
echo "smoke test failed: $URL" >&2
exit 1

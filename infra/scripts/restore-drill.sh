#!/usr/bin/env bash
# Restore-from-backup drill (infra/README.md, "Restore drill").
# Restores the environment's RDS database into a NEW instance, runs the
# read-only restore check (dist/db/restore-check.js) inside the VPC as a
# one-off migrate task pointed at the copy, reports RTO and RPO, then deletes
# the copy. The live database is only read (describe calls), never changed.
#
#   infra/scripts/restore-drill.sh <staging|production> [--snapshot <id>|latest] [--keep]
#
# Default restore source is point-in-time (latest restorable time); --snapshot
# restores an automated or manual snapshot instead. --keep leaves the copy
# running for inspection (delete it yourself; it is billed hourly).
# Needs: aws CLI v2 with admin credentials, jq, terragrunt (for stack outputs).
# Without terragrunt, set CLUSTER, TASK_FAMILY, SUBNETS (comma-separated) and SECURITY_GROUP.
set -euo pipefail

say() { printf '\033[1;34m==>\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31mxx\033[0m %s\n' "$*" >&2; exit 1; }
now() { date -u +%s; }
# Portable (GNU and macOS) date handling through Node, which local development already needs.
iso() { node -e 'console.log(new Date(Number(process.argv[1]) * 1000).toISOString())' "$1"; }
epoch() { node -e 'const t = Date.parse(process.argv[1]); if (Number.isNaN(t)) process.exit(1); console.log(Math.floor(t / 1000))' "$1"; }
dur() { printf '%dm%02ds' $(($1 / 60)) $(($1 % 60)); }

ENVIRONMENT="${1:-}"
shift || true
SNAPSHOT=""
KEEP=false
while [ $# -gt 0 ]; do
  case "$1" in
    --snapshot) SNAPSHOT="${2:?--snapshot needs an id or 'latest'}"; shift 2 ;;
    --keep) KEEP=true; shift ;;
    *) die "unknown argument: $1" ;;
  esac
done

case "$ENVIRONMENT" in
  staging) export AWS_REGION="${AWS_REGION:-us-east-2}" ;;
  production) export AWS_REGION="${AWS_REGION:-us-east-1}" ;;
  *) die "usage: $0 <staging|production> [--snapshot <id>|latest] [--keep]" ;;
esac
for tool in aws jq node; do command -v "$tool" >/dev/null || die "$tool is required"; done

SOURCE="eureka-${ENVIRONMENT}"
DRILL="${SOURCE}-drill-$(date -u +%Y%m%d%H%M)"
LOG_GROUP="/eureka/${ENVIRONMENT}/migrate"

# ---- stack outputs (network and task definition for the check task) ---------------------------
if [ -z "${CLUSTER:-}" ] || [ -z "${TASK_FAMILY:-}" ] || [ -z "${SUBNETS:-}" ] || [ -z "${SECURITY_GROUP:-}" ]; then
  command -v terragrunt >/dev/null || die "terragrunt is required (or set CLUSTER, TASK_FAMILY, SUBNETS, SECURITY_GROUP)"
  say "Reading stack outputs (infra/live/${ENVIRONMENT})"
  OUT=$(cd "$(dirname "$0")/../live/${ENVIRONMENT}" && terragrunt output -json)
  CLUSTER="${CLUSTER:-$(jq -r .ecs_cluster.value <<<"$OUT")}"
  TASK_FAMILY="${TASK_FAMILY:-$(jq -r .migrate_task_definition.value <<<"$OUT")}"
  SUBNETS="${SUBNETS:-$(jq -r '.public_subnet_ids.value | join(",")' <<<"$OUT")}"
  SECURITY_GROUP="${SECURITY_GROUP:-$(jq -r .jobs_security_group_id.value <<<"$OUT")}"
fi

# ---- source instance: same subnet group, security group, parameter group and class -------------
SRC=$(aws rds describe-db-instances --db-instance-identifier "$SOURCE" --query 'DBInstances[0]' --output json)
SUBNET_GROUP=$(jq -r .DBSubnetGroup.DBSubnetGroupName <<<"$SRC")
read -r -a DB_SGS <<<"$(jq -r '[.VpcSecurityGroups[].VpcSecurityGroupId] | join(" ")' <<<"$SRC")"
PARAM_GROUP=$(jq -r '.DBParameterGroups[0].DBParameterGroupName' <<<"$SRC")
CLASS=$(jq -r .DBInstanceClass <<<"$SRC")
# shellcheck disable=SC2054 # the commas are inside the --tags values
COMMON=(--db-subnet-group-name "$SUBNET_GROUP" --vpc-security-group-ids "${DB_SGS[@]}"
  --db-parameter-group-name "$PARAM_GROUP" --db-instance-class "$CLASS" --no-multi-az --no-publicly-accessible
  --no-deletion-protection --tags Key=purpose,Value=restore-drill Key=source,Value="$SOURCE"
  Key=Project,Value=Eureka Key=Environment,Value="$ENVIRONMENT")

cleanup() {
  if [ "$KEEP" = true ]; then
    say "Keeping $DRILL (delete it with: aws rds delete-db-instance --db-instance-identifier $DRILL --skip-final-snapshot --delete-automated-backups)"
    return
  fi
  case "$DRILL" in *-drill-*) ;; *) die "refusing to delete $DRILL" ;; esac
  if aws rds describe-db-instances --db-instance-identifier "$DRILL" >/dev/null 2>&1; then
    say "Teardown: deleting $DRILL (no final snapshot)"
    aws rds delete-db-instance --db-instance-identifier "$DRILL" --skip-final-snapshot --delete-automated-backups >/dev/null
  fi
}
trap cleanup EXIT

T0=$(now)
if [ -z "$SNAPSHOT" ]; then
  RESTORE_POINT=$(jq -r .LatestRestorableTime <<<"$SRC")
  say "Point-in-time restore of $SOURCE to $DRILL (latest restorable time $RESTORE_POINT)"
  aws rds restore-db-instance-to-point-in-time --source-db-instance-identifier "$SOURCE" \
    --target-db-instance-identifier "$DRILL" --use-latest-restorable-time "${COMMON[@]}" >/dev/null
else
  if [ "$SNAPSHOT" = latest ]; then
    # shellcheck disable=SC2016 # JMESPath literal, not a shell expansion
    SNAPSHOT=$(aws rds describe-db-snapshots --db-instance-identifier "$SOURCE" --snapshot-type automated \
      --query 'reverse(sort_by(DBSnapshots[?Status==`available`], &SnapshotCreateTime))[0].DBSnapshotIdentifier' --output text)
    [ "$SNAPSHOT" != None ] || die "no available automated snapshot for $SOURCE"
  fi
  RESTORE_POINT=$(aws rds describe-db-snapshots --db-snapshot-identifier "$SNAPSHOT" \
    --query 'DBSnapshots[0].SnapshotCreateTime' --output text)
  say "Snapshot restore of $SNAPSHOT (taken $RESTORE_POINT) to $DRILL"
  aws rds restore-db-instance-from-db-snapshot --db-snapshot-identifier "$SNAPSHOT" \
    --db-instance-identifier "$DRILL" "${COMMON[@]}" >/dev/null
fi
RPO_S=$(( T0 - $(epoch "$RESTORE_POINT") ))

say "Waiting for $DRILL to become available (usually 10-30 minutes)"
until [ "$(aws rds describe-db-instances --db-instance-identifier "$DRILL" --query 'DBInstances[0].DBInstanceStatus' --output text)" = available ]; do
  sleep 30
done
T_AVAILABLE=$(now)
ENDPOINT=$(aws rds describe-db-instances --db-instance-identifier "$DRILL" --query 'DBInstances[0].Endpoint.Address' --output text)
say "Available after $(dur $((T_AVAILABLE - T0))): $ENDPOINT"

# RDS rotates the managed master secret, so the copy may hold an older master
# password than the secret the check task reads: set the copy to the current one.
SECRET_ARN=$(jq -r '.MasterUserSecret.SecretArn // empty' <<<"$SRC")
if [ -n "$SECRET_ARN" ]; then
  say "Aligning the copy's master password with the current secret"
  aws rds modify-db-instance --db-instance-identifier "$DRILL" --apply-immediately \
    --master-user-password "$(aws secretsmanager get-secret-value --secret-id "$SECRET_ARN" \
      --query SecretString --output text | jq -r .password)" >/dev/null
  sleep 30
  until [ "$(aws rds describe-db-instances --db-instance-identifier "$DRILL" --query 'DBInstances[0].DBInstanceStatus' --output text)" = available ]; do
    sleep 15
  done
fi

say "Running the restore check as a one-off $TASK_FAMILY task against the copy"
OVERRIDES=$(jq -nc --arg host "$ENDPOINT" \
  '{containerOverrides: [{name: "migrate", command: ["node", "dist/db/restore-check.js"], environment: [{name: "DB_HOST", value: $host}]}]}')
TASK=$(aws ecs run-task --cluster "$CLUSTER" --task-definition "$TASK_FAMILY" --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[${SUBNETS}],securityGroups=[${SECURITY_GROUP}],assignPublicIp=ENABLED}" \
  --overrides "$OVERRIDES" --started-by "restore-drill" --propagate-tags TASK_DEFINITION --query 'tasks[0].taskArn' --output text)
aws ecs wait tasks-stopped --cluster "$CLUSTER" --tasks "$TASK"
CODE=$(aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$TASK" --query 'tasks[0].containers[0].exitCode' --output text)
T_CHECKED=$(now)
aws logs get-log-events --log-group-name "$LOG_GROUP" --log-stream-name "migrate/migrate/${TASK##*/}" \
  --query 'events[].message' --output text 2>/dev/null || say "(could not read the task log; see $LOG_GROUP)"

RTO_S=$((T_CHECKED - T0))
cat <<EOF

Restore drill: $ENVIRONMENT  ($(iso "$T0"))
  source            $SOURCE
  restored copy     $DRILL
  restore point     $RESTORE_POINT
  RPO (data loss)   $(dur "$RPO_S")  (drill start minus restore point)
  available after   $(dur $((T_AVAILABLE - T0)))
  RTO (to verified) $(dur "$RTO_S")
  restore check     exit code $CODE
EOF
[ "$CODE" = 0 ] || die "restore check failed (exit code $CODE); see the JSON line above"

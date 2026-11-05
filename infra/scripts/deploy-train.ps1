<#
.SYNOPSIS
  Windows (PowerShell) port of deploy-train.sh + deploy-local.sh: batched staging deploys.

.DESCRIPTION
  status            deployed sha, queued changes, lock holder
  go [-Force]       deploy origin/main to staging if >= DEPLOY_TRAIN_MIN changes are queued (or -Force)
  deploy [-Environment staging|production] [-Yes]
                    deploy the current checkout directly (deploy-local.sh); asks before touching AWS unless -Yes

  Same steps as the bash scripts: ECR repo, arm64 image build + push, migrate task, full terragrunt
  apply, web publish to S3/CloudFront, smoke test. "go" always deploys origin/main from a dedicated
  worktree (.claude/worktrees/deploy-staging), never the caller's HEAD. A "change" is a non-merge commit
  touching anything besides docs/ or *.md.

  Needs on PATH: git, aws (admin creds), docker (Docker Desktop; arm64 builds via emulation on x64),
  terragrunt, terraform, pnpm (Node 22+). No jq or bash needed. Works in Windows PowerShell 5.1 and pwsh 7.

  The lock lives in this clone's git dir, like the bash train's. Another machine (e.g. the Mac) has its own
  lock: deploy from one machine at a time. Both read the deployed sha from ECS, so their queues agree.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File infra\scripts\deploy-train.ps1 status
  powershell -ExecutionPolicy Bypass -File infra\scripts\deploy-train.ps1 go
  powershell -ExecutionPolicy Bypass -File infra\scripts\deploy-train.ps1 go -Force
#>
[CmdletBinding()]
param(
  [Parameter(Position = 0)][ValidateSet("status", "go", "deploy")][string]$Command = "status",
  [switch]$Force,
  [ValidateSet("staging", "production")][string]$Environment = "staging",
  [switch]$Yes
)
$ErrorActionPreference = "Stop"

$Min = if ($env:DEPLOY_TRAIN_MIN) { [int]$env:DEPLOY_TRAIN_MIN } else { 3 }
$Max = if ($env:DEPLOY_TRAIN_MAX) { [int]$env:DEPLOY_TRAIN_MAX } else { 5 }
$StagingRegion = "us-east-2"
$StagingCluster = "eureka-staging"

# Runs a native command and stops on a non-zero exit (PowerShell does not do that by itself).
# Plain functions on purpose: tokens like -json, -t or -auto-approve must reach the native
# command untouched, and an advanced function would try to bind them as its own parameters.
# EAP Continue inside: with output redirected (the train's *> log), Windows PowerShell 5.1 turns every
# native stderr line (terragrunt/docker progress) into a NativeCommandError, and Stop would abort on it.
# The exit code alone decides failure.
function Invoke-Native {
  $ErrorActionPreference = "Continue"
  $exe = $args[0]
  $rest = @(); if ($args.Count -gt 1) { $rest = $args[1..($args.Count - 1)] }
  & $exe @rest
  if ($LASTEXITCODE -ne 0) { throw "$exe $($rest -join ' ') failed with exit code $LASTEXITCODE" }
}

# Same, returning trimmed stdout as one string.
function Get-Native {
  $ErrorActionPreference = "Continue"
  $exe = $args[0]
  $rest = @(); if ($args.Count -gt 1) { $rest = $args[1..($args.Count - 1)] }
  $out = & $exe @rest
  if ($LASTEXITCODE -ne 0) { throw "$exe $($rest -join ' ') failed with exit code $LASTEXITCODE" }
  return (($out | Out-String).Trim())
}

# Real executables only: the deploy child runs with -NoProfile, so profile aliases/functions are gone there.
function Assert-Tools {
  $missing = @("git", "aws", "docker", "terragrunt", "terraform", "pnpm") |
    Where-Object { -not (Get-Command $_ -CommandType Application -ErrorAction SilentlyContinue) }
  if ($missing) {
    throw ("not on PATH as executables: $($missing -join ', '). " +
      "Install them or add their folder to PATH (a `$PROFILE alias is not enough; the deploy runs with -NoProfile).")
  }
}

# ---------------------------------------------------------------- deploy (deploy-local.sh)

function Invoke-Deploy {
  param([string]$Root, [string]$Target, [switch]$NoPrompt)
  Assert-Tools
  $region = if ($Target -eq "production") { "us-east-1" } else { "us-east-2" }
  $env:AWS_REGION = $region
  $env:AWS_DEFAULT_REGION = $region
  $env:TG_NON_INTERACTIVE = "true"

  $live = Join-Path $Root "infra\live\$Target"
  $tag = Get-Native git -C $Root rev-parse HEAD
  if (Get-Native git -C $Root status --porcelain --untracked-files=no) {
    # Tags are immutable; never reuse a SHA for different content.
    $tag = "$tag-dirty-$([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())"
  }
  $env:TF_VAR_image_tag = $tag

  $account = Get-Native aws sts get-caller-identity --query Account --output text
  $registry = "$account.dkr.ecr.$region.amazonaws.com"
  $image = "$registry/eureka-$Target-api:$tag"

  Write-Host ">> $Target / $region / account $account / tag $tag"
  if (-not $NoPrompt) {
    $ok = Read-Host "Deploy to AWS now? [y/N]"
    if ($ok -ne "y") { exit 1 }
  }

  Push-Location $live
  try {
    Write-Host ">> 1. ECR repository"
    Invoke-Native terragrunt apply -auto-approve -input=false "-target=aws_ecr_repository.api"

    Write-Host ">> 2. Build and push image"
    $pw = Get-Native aws ecr get-login-password
    & { $ErrorActionPreference = "Continue"; $pw | docker login --username AWS --password-stdin $registry }
    if ($LASTEXITCODE -ne 0) { throw "docker login failed" }
    Invoke-Native docker build --platform linux/arm64 -t $image $Root
    Invoke-Native docker push $image

    Write-Host ">> 3. Migrate task definition"
    Invoke-Native terragrunt apply -auto-approve -input=false `
      "-target=aws_ecs_task_definition.migrate" `
      "-target=aws_ecs_cluster.main" `
      "-target=aws_route_table_association.public" `
      "-target=aws_vpc_endpoint.s3" `
      "-target=aws_vpc_security_group_egress_rule.jobs_https" `
      "-target=aws_vpc_security_group_egress_rule.jobs_db" `
      "-target=aws_vpc_security_group_ingress_rule.db_from_jobs" `
      "-target=aws_iam_role_policy_attachment.execution" `
      "-target=aws_iam_role_policy.execution_secrets"

    $out = Get-Native terragrunt output -json | ConvertFrom-Json
    $cluster = $out.ecs_cluster.value
    $td = $out.migrate_task_definition.value
    $subnets = ($out.public_subnet_ids.value -join ",")
    $sg = $out.jobs_security_group_id.value

    Write-Host ">> 4. Run migrations"
    $net = "awsvpcConfiguration={subnets=[$subnets],securityGroups=[$sg],assignPublicIp=ENABLED}"
    $task = Get-Native aws ecs run-task --cluster $cluster --task-definition $td --launch-type FARGATE `
      --network-configuration $net --started-by "local-$env:USERNAME" --query "tasks[0].taskArn" --output text
    Write-Host "migrate task: $task"
    Invoke-Native aws ecs wait tasks-stopped --cluster $cluster --tasks $task
    $code = Get-Native aws ecs describe-tasks --cluster $cluster --tasks $task --query "tasks[0].containers[0].exitCode" --output text
    Write-Host "exit code: $code"
    if ($code -ne "0") { throw "migrations failed (exit code $code)" }

    Write-Host ">> 5. Apply full stack"
    Invoke-Native terragrunt apply -auto-approve -input=false
    $out = Get-Native terragrunt output -json | ConvertFrom-Json
    Invoke-Native aws ecs wait services-stable --cluster $out.ecs_cluster.value --services $out.api_service.value
  } finally {
    Pop-Location
  }

  Write-Host ">> 6. Publish web"
  Push-Location $Root
  try {
    Invoke-Native pnpm install --frozen-lockfile --filter "@eureka/web..."
    Invoke-Native pnpm --filter "@eureka/web" build
    $bucket = $out.web_bucket.value
    $dist = $out.cloudfront_distribution_id.value
    Invoke-Native aws s3 sync apps/web/dist "s3://$bucket" --delete --exclude index.html `
      --cache-control "public,max-age=31536000,immutable"
    Invoke-Native aws s3 cp apps/web/dist/index.html "s3://$bucket/index.html" `
      --cache-control "no-cache,no-store,must-revalidate"
    Invoke-Native aws cloudfront create-invalidation --distribution-id $dist --paths "/index.html" "/"
  } finally {
    Pop-Location
  }

  Write-Host ">> 7. Smoke test"
  $url = $out.app_url.value
  for ($i = 0; $i -lt 10; $i++) {
    try {
      $r = Invoke-WebRequest -Uri "$url/api/health" -UseBasicParsing -TimeoutSec 20
      Write-Host $r.Content
      Write-Host "OK $url"
      return
    } catch {
      Start-Sleep -Seconds 15
    }
  }
  throw "smoke test failed: $url"
}

if ($Command -eq "deploy") {
  $root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
  Invoke-Deploy -Root $root -Target $Environment -NoPrompt:$Yes
  exit 0
}

# ---------------------------------------------------------------- train (deploy-train.sh)

$common = Get-Native git rev-parse --path-format=absolute --git-common-dir
$repo = Split-Path $common -Parent
$lock = Join-Path $common "deploy-staging.lock"
$last = Join-Path $common "deploy-staging.last" # sha of the last train, read by scripts/session-brief.sh
$log = Join-Path $common "deploy-staging.log"
$deployWt = Join-Path $repo ".claude\worktrees\deploy-staging"

# Image tag of the running staging api = the sha it was built from.
function Get-DeployedSha {
  $td = Get-Native aws ecs describe-services --region $StagingRegion --cluster $StagingCluster --services api `
    --query "services[0].taskDefinition" --output text
  $img = Get-Native aws ecs describe-task-definition --region $StagingRegion --task-definition $td `
    --query "taskDefinition.containerDefinitions[0].image" --output text
  return (($img -replace ".*:", "") -replace "-dirty-.*", "")
}

# Non-doc commits on origin/main after $since, one "sha subject" per line.
function Get-Queued([string]$since) {
  $result = @()
  $commits = git rev-list --no-merges --reverse "$since..origin/main"
  foreach ($c in $commits) {
    if (-not $c) { continue }
    $files = git diff-tree --no-commit-id --name-only -r $c
    if ($files | Where-Object { $_ -notmatch '^docs/' -and $_ -notmatch '\.md$' }) {
      $result += (git log -1 --format="%h %s" $c)
    }
  }
  return , $result
}

# Holder info if a live deploy holds the lock; clears a stale lock.
function Get-LockHolder {
  if (-not (Test-Path $lock)) { return $null }
  $lockPid = Get-Content (Join-Path $lock "pid") -ErrorAction SilentlyContinue
  if ($lockPid -and (Get-Process -Id ([int]$lockPid) -ErrorAction SilentlyContinue)) {
    return (Get-Content (Join-Path $lock "info") -Raw).Trim()
  }
  Remove-Item -Recurse -Force $lock
  return $null
}

Invoke-Native git fetch -q origin main
$deployed = Get-DeployedSha
Set-Content -Path $last -Value $deployed -NoNewline
# Windows PowerShell turns redirected native stderr into errors; this check expects it may fail.
$ErrorActionPreference = "Continue"
git cat-file -e "$deployed^{commit}" 2>$null
$known = ($LASTEXITCODE -eq 0)
$ErrorActionPreference = "Stop"
if (-not $known) {
  Write-Warning "staging runs $deployed, unknown to git here; treating all of origin/main as queued"
  $deployed = (git rev-list --max-parents=0 origin/main | Select-Object -Last 1)
}
$queue = Get-Queued $deployed
$n = $queue.Count
$head = Get-Native git rev-parse --short=9 origin/main
$short = $deployed.Substring(0, [Math]::Min(9, $deployed.Length))

Write-Host "staging: $short   origin/main: $head   queued: $n (train leaves at $Min, overdue at $Max)"
$queue | ForEach-Object { Write-Host "  $_" }
$holder = Get-LockHolder
if ($holder) { Write-Host "deploy running: $holder (log: $log)" }

if ($Command -eq "status") { exit 0 }

if (Get-LockHolder) { Write-Host "train already running; your commits ride the next one"; exit 0 }
if ($n -eq 0) { Write-Host "nothing to deploy"; exit 0 }
if ($n -lt $Min -and -not $Force) {
  Write-Host "only $n/$Min queued; not deploying (commits stay queued; -Force if the user asked for this now)"
  exit 0
}
Assert-Tools

try {
  New-Item -ItemType Directory -Path $lock -ErrorAction Stop | Out-Null
} catch {
  Write-Host "lost the race for the lock; train already running"
  exit 0
}
try {
  $sha = Get-Native git rev-parse origin/main
  Set-Content -Path (Join-Path $lock "pid") -Value $PID
  Set-Content -Path (Join-Path $lock "info") -Value "pid $PID, $($sha.Substring(0,9)), $n changes, started $(Get-Date -Format HH:mm) (Windows)"

  if (Test-Path $deployWt) {
    Invoke-Native git -C $deployWt checkout -q --detach --force $sha
  } else {
    Invoke-Native git worktree add -q --detach $deployWt $sha
  }

  Write-Host ">> train $($sha.Substring(0,9)) with $n changes; log: $log"
  # Run the deploy from the worktree's copy of this script, so the deployed code and the steps match.
  $wtScript = Join-Path $deployWt "infra\scripts\deploy-train.ps1"
  $shell = (Get-Process -Id $PID).Path
  $ErrorActionPreference = "Continue" # the child's stderr goes to the log, not into errors here
  & $shell -NoProfile -ExecutionPolicy Bypass -File $wtScript deploy -Environment staging -Yes *> $log
  $deployCode = $LASTEXITCODE
  $ErrorActionPreference = "Stop"
  if ($deployCode -eq 0) {
    Set-Content -Path $last -Value $sha -NoNewline
    Write-Host "OK: staging now at $($sha.Substring(0,9))"
    Get-Content $log -Tail 2
  } else {
    Write-Host "FAILED: see $log (last 30 lines below)" -ForegroundColor Red
    Get-Content $log -Tail 30 | ForEach-Object { Write-Host "  $_" }
    exit 1
  }
} finally {
  Remove-Item -Recurse -Force $lock -ErrorAction SilentlyContinue
}

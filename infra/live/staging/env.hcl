# Staging — NOT deployed by default (cost). Create it when you need a
# pre-production check and destroy it afterwards:
#   cd infra/live/staging && terragrunt apply   ...   terragrunt destroy
# Same account and region pattern as spokenly staging (us-east-2).
# CIDR 10.41.0.0/16 does not overlap spokenly (10.0.0.0/16, 172.16.0.0/16),
# so the VPCs can be peered later if needed.
locals {
  environment = "staging"
  account_id  = "637423353261"
  aws_region  = "us-east-2"

  # eureka.spokenly.click is used by spokenly staging, so Eureka staging uses its own name.
  domain_name       = "eureka-staging.spokenly.click"
  hosted_zone_name  = "spokenly.click"
  google_hosted_domain = "aceintegrator.com"
  # Staging test users: exact emails (comma-separated) outside the domain that may sign in. Staging only.
  auth_test_emails = ""
  # Username + password sign-in for test users (migration 0083). Staging only; production stays off.
  password_login = "on"
  # Migration 0084: one administrator can grant restricted roles without a second approver. Set "off" to restore AD-3.
  single_admin_mode = "on"
  # jobs-portal: SES sender of applicant sign-in links and application notices (required by the API).
  portal_from_email = "careers@eureka-staging.spokenly.click"

  vpc_cidr             = "10.41.0.0/16"
  public_subnet_cidrs  = ["10.41.1.0/24", "10.41.2.0/24"]
  private_subnet_cidrs = ["10.41.11.0/24", "10.41.12.0/24"]

  db_instance_class        = "db.t4g.micro"
  db_multi_az              = false
  db_allocated_storage     = 20
  db_backup_retention_days = 7
  db_deletion_protection   = false

  api_cpu           = 256
  api_memory        = 512
  api_desired_count = 1
  api_max_count     = 2
  worker_desired_count = 1 # audit export and cleanup jobs; email stays off until a sender is set
  use_fargate_spot  = true

  audit_lock_mode = "GOVERNANCE"
  audit_lock_days = 1
  log_retention_days = 7
  waf_rate_limit_per_5min = 2000
}

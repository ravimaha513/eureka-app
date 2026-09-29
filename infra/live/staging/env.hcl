# Staging — same account and region pattern as spokenly staging (us-east-2).
# CIDR 10.41.0.0/16 does not overlap spokenly (10.0.0.0/16, 172.16.0.0/16),
# so the VPCs can be peered later if needed.
locals {
  environment = "staging"
  account_id  = "637423353261"
  aws_region  = "us-east-2"

  # TODO(Ravi): pick the staging hostname. eureka.spokenly.click is already used
  # by spokenly staging, so Eureka needs a different name.
  domain_name       = "eureka-staging.spokenly.click"
  hosted_zone_name  = "spokenly.click"
  google_hosted_domain = "" # TODO: company Google Workspace domain

  vpc_cidr             = "10.41.0.0/16"
  public_subnet_cidrs  = ["10.41.1.0/24", "10.41.2.0/24"]
  private_subnet_cidrs = ["10.41.11.0/24", "10.41.12.0/24"]
  nat_gateway_count    = 1

  db_instance_class        = "db.t4g.small"
  db_multi_az              = false
  db_allocated_storage     = 20
  db_backup_retention_days = 7
  db_deletion_protection   = false

  api_cpu           = 256
  api_memory        = 512
  api_desired_count = 1
  api_max_count     = 2
  worker_desired_count = 0 # worker ships in Phase 2
  use_fargate_spot  = true

  audit_lock_mode = "GOVERNANCE"
  audit_lock_days = 1
  log_retention_days = 14
  waf_rate_limit_per_5min = 2000
}

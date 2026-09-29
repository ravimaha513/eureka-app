# Production — us-east-1 like spokenly production. Deploys require approval
# in the GitHub "production" environment.
locals {
  environment = "production"
  account_id  = "637423353261"
  aws_region  = "us-east-1"

  domain_name          = "" # TODO(Ravi): production hostname, e.g. eureka.<company-domain>
  hosted_zone_name     = "" # TODO: Route 53 zone for that hostname
  google_hosted_domain = "" # TODO: company Google Workspace domain

  vpc_cidr             = "10.40.0.0/16"
  public_subnet_cidrs  = ["10.40.1.0/24", "10.40.2.0/24"]
  private_subnet_cidrs = ["10.40.11.0/24", "10.40.12.0/24"]
  nat_gateway_count    = 2

  db_instance_class        = "db.t4g.medium"
  db_multi_az              = true
  db_allocated_storage     = 50
  db_backup_retention_days = 35
  db_deletion_protection   = true

  api_cpu           = 512
  api_memory        = 1024
  api_desired_count = 2
  api_max_count     = 6
  worker_desired_count = 0 # worker ships in Phase 2
  use_fargate_spot  = false

  audit_lock_mode = "COMPLIANCE"
  audit_lock_days = 2555 # 7 years (design A6.4)
  log_retention_days = 90
  waf_rate_limit_per_5min = 3000
}

# Production — us-east-1 like spokenly production. Sized for an internal app
# with tens of users; see infra/README.md "Cost" for what each knob costs and
# when to turn it up (Multi-AZ, a second task, a larger instance).
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

  db_instance_class        = "db.t4g.micro" # 2 vCPU burst, 1 GiB; ~$12/month
  db_multi_az              = false          # true doubles the RDS bill; point-in-time restore covers MVP
  db_allocated_storage     = 20
  db_backup_retention_days = 14
  db_deletion_protection   = true

  api_cpu           = 256
  api_memory        = 512
  api_desired_count = 1
  api_max_count     = 3
  worker_desired_count = 0 # worker ships in Phase 2
  use_fargate_spot  = false

  audit_lock_mode = "COMPLIANCE"
  audit_lock_days = 1095 # 3 years (OD-03). COMPLIANCE mode cannot be shortened later.
  log_retention_days = 30
  waf_rate_limit_per_5min = 3000
}

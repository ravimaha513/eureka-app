# PostgreSQL 16 on RDS (design A5). Private subnets only, TLS enforced,
# KMS-encrypted, master password managed by RDS in Secrets Manager.

resource "aws_db_subnet_group" "main" {
  name       = local.name
  subnet_ids = aws_subnet.private[*].id
}

resource "aws_security_group" "db" {
  name        = "${local.name}-db"
  description = "PostgreSQL: only from API and worker tasks"
  vpc_id      = aws_vpc.main.id
  tags        = { Name = "${local.name}-db" }
}

resource "aws_vpc_security_group_ingress_rule" "db_from_tasks" {
  security_group_id            = aws_security_group.db.id
  referenced_security_group_id = aws_security_group.tasks.id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  description                  = "Postgres from ECS API tasks"
}

resource "aws_vpc_security_group_ingress_rule" "db_from_jobs" {
  security_group_id            = aws_security_group.db.id
  referenced_security_group_id = aws_security_group.jobs.id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  description                  = "Postgres from ECS worker and migrate tasks"
}

resource "aws_db_parameter_group" "pg16" {
  name   = "${local.name}-pg16"
  family = "postgres16"
  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }
  parameter {
    name  = "log_min_duration_statement"
    value = "1000"
  }
  parameter {
    name  = "log_connections"
    value = "1"
  }
  parameter {
    name  = "log_disconnections"
    value = "1"
  }
  parameter {
    name         = "shared_preload_libraries"
    value        = "pg_stat_statements"
    apply_method = "pending-reboot"
  }
}

resource "aws_db_instance" "main" {
  identifier     = local.name
  engine         = "postgres"
  engine_version = "16"
  instance_class = var.db_instance_class

  allocated_storage     = var.db_allocated_storage
  max_allocated_storage = var.db_allocated_storage * 4
  storage_type          = "gp3"
  storage_encrypted     = true
  kms_key_id            = aws_kms_key.data.arn

  db_name                       = "eureka"
  username                      = "eureka_admin"
  manage_master_user_password   = true
  master_user_secret_kms_key_id = aws_kms_key.data.arn

  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.db.id]
  publicly_accessible    = false
  multi_az               = var.db_multi_az
  parameter_group_name   = aws_db_parameter_group.pg16.name

  backup_retention_period             = var.db_backup_retention_days
  backup_window                       = "07:00-08:00"         # 3-4 AM ET
  maintenance_window                  = "sun:08:30-sun:09:30" # Sunday early morning ET
  copy_tags_to_snapshot               = true
  deletion_protection                 = var.db_deletion_protection
  skip_final_snapshot                 = !local.is_prod
  final_snapshot_identifier           = local.is_prod ? "${local.name}-final" : null
  auto_minor_version_upgrade          = true
  iam_database_authentication_enabled = true

  # Cost: no Enhanced Monitoring or Performance Insights (basic CloudWatch
  # metrics are free); slow queries still reach CloudWatch through the log export.
  performance_insights_enabled    = false
  monitoring_interval             = 0
  enabled_cloudwatch_logs_exports = ["postgresql"]
}

# Runtime configuration lives in SSM Parameter Store (SecureString, standard
# tier: free) instead of Secrets Manager ($0.40 per secret per month). Only the
# RDS master password stays in Secrets Manager, where RDS manages and rotates it.
resource "random_password" "db_role" {
  for_each = toset(["app", "worker"])
  length   = 40
  special  = false
}

resource "random_password" "session_secret" {
  length  = 64
  special = false
}

resource "random_password" "origin_secret" {
  length  = 48
  special = false
}

locals {
  ssm_prefix = "/eureka/${var.environment}"
  generated_params = {
    "db/app/password"    = random_password.db_role["app"].result
    "db/app/url"         = "postgres://eureka_app:${random_password.db_role["app"].result}@${aws_db_instance.main.address}:5432/eureka?sslmode=verify-full"
    "db/worker/password" = random_password.db_role["worker"].result
    "db/worker/url"      = "postgres://eureka_worker:${random_password.db_role["worker"].result}@${aws_db_instance.main.address}:5432/eureka?sslmode=verify-full"
    "app/session_secret" = random_password.session_secret.result
    "app/origin_secret"  = random_password.origin_secret.result
  }
}

resource "aws_ssm_parameter" "generated" {
  for_each = local.generated_params
  name     = "${local.ssm_prefix}/${each.key}"
  type     = "SecureString"
  tier     = "Standard"
  key_id   = aws_kms_key.data.arn
  value    = each.value
}

# Google OAuth client credentials are entered once by hand (never in code):
#   aws ssm put-parameter --overwrite --type SecureString --key-id alias/eureka-<env>-data \
#     --name /eureka/<env>/app/google_client_id --value ...
resource "aws_ssm_parameter" "google" {
  for_each = toset(["google_client_id", "google_client_secret"])
  name     = "${local.ssm_prefix}/app/${each.key}"
  type     = "SecureString"
  tier     = "Standard"
  key_id   = aws_kms_key.data.arn
  value    = "set-me"
  lifecycle { ignore_changes = [value] }
}

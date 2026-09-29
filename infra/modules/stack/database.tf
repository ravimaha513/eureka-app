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
  description                  = "Postgres from ECS tasks"
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

  performance_insights_enabled          = true
  performance_insights_kms_key_id       = aws_kms_key.data.arn
  performance_insights_retention_period = 7
  monitoring_interval                   = 60
  monitoring_role_arn                   = aws_iam_role.rds_monitoring.arn
  enabled_cloudwatch_logs_exports       = ["postgresql", "upgrade"]
}

resource "aws_iam_role" "rds_monitoring" {
  name = "${local.name}-rds-monitoring"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "monitoring.rds.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy_attachment" "rds_monitoring" {
  role       = aws_iam_role.rds_monitoring.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonRDSEnhancedMonitoringRole"
}

# Application role passwords (eureka_app, eureka_worker); the migrate task sets
# them in PostgreSQL from these secrets. Rotation: Phase 5 (Secrets Manager rotation Lambda).
resource "random_password" "db_role" {
  for_each = toset(["app", "worker"])
  length   = 40
  special  = false
}

resource "aws_secretsmanager_secret" "db_role" {
  for_each   = random_password.db_role
  name       = "eureka/${var.environment}/db/${each.key}"
  kms_key_id = aws_kms_key.data.arn
}

resource "aws_secretsmanager_secret_version" "db_role" {
  for_each  = random_password.db_role
  secret_id = aws_secretsmanager_secret.db_role[each.key].id
  secret_string = jsonencode({
    username = "eureka_${each.key}"
    password = each.value.result
    url      = "postgres://eureka_${each.key}:${each.value.result}@${aws_db_instance.main.address}:5432/eureka?sslmode=verify-full"
  })
}

resource "random_password" "session_secret" {
  length  = 64
  special = false
}

resource "aws_secretsmanager_secret" "app" {
  name       = "eureka/${var.environment}/app"
  kms_key_id = aws_kms_key.data.arn
}

# Google OAuth client credentials are entered once in the console (never in code).
resource "aws_secretsmanager_secret_version" "app" {
  secret_id = aws_secretsmanager_secret.app.id
  secret_string = jsonencode({
    SESSION_SECRET       = random_password.session_secret.result
    GOOGLE_CLIENT_ID     = "set-in-console"
    GOOGLE_CLIENT_SECRET = "set-in-console"
  })
  lifecycle { ignore_changes = [secret_string] }
}

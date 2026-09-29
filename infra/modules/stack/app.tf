# Compute (design A5 "Compute", A8): ECR, ECS Fargate API and worker, one-off
# migrate task, ALB reachable only from CloudFront with a shared origin secret.

resource "aws_ecr_repository" "api" {
  name                 = "${local.name}-api"
  image_tag_mutability = "IMMUTABLE"
  image_scanning_configuration { scan_on_push = true }
  encryption_configuration {
    encryption_type = "KMS"
    kms_key         = aws_kms_key.data.arn
  }
}

resource "aws_ecr_lifecycle_policy" "api" {
  repository = aws_ecr_repository.api.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep last 30 images"
      selection    = { tagStatus = "any", countType = "imageCountMoreThan", countNumber = 30 }
      action       = { type = "expire" }
    }]
  })
}

resource "aws_ecs_cluster" "main" {
  name = local.name
  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

resource "aws_ecs_cluster_capacity_providers" "main" {
  cluster_name       = aws_ecs_cluster.main.name
  capacity_providers = ["FARGATE", "FARGATE_SPOT"]
}

resource "aws_cloudwatch_log_group" "app" {
  for_each          = toset(["api", "worker", "migrate"])
  name              = "/eureka/${var.environment}/${each.key}"
  retention_in_days = var.log_retention_days
  kms_key_id        = aws_kms_key.logs.arn
}

# ---------- IAM ----------
data "aws_iam_policy_document" "ecs_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }
}

# Execution role: pull image, write logs, read only this environment's secrets.
resource "aws_iam_role" "execution" {
  name               = "${local.name}-ecs-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

resource "aws_iam_role_policy_attachment" "execution" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role_policy" "execution_secrets" {
  role = aws_iam_role.execution.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = ["secretsmanager:GetSecretValue"]
        Resource = concat(
          [for s in aws_secretsmanager_secret.db_role : s.arn],
          [aws_secretsmanager_secret.app.arn, aws_db_instance.main.master_user_secret[0].secret_arn],
        )
      },
      {
        Effect   = "Allow"
        Action   = ["kms:Decrypt"]
        Resource = [aws_kms_key.data.arn]
      },
    ]
  })
}

# API task role: documents bucket prefixes, field-encryption key, SES send.
resource "aws_iam_role" "api" {
  name               = "${local.name}-api-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

resource "aws_iam_role_policy" "api" {
  role = aws_iam_role.api.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "UploadToQuarantineOnly"
        Effect   = "Allow"
        Action   = ["s3:PutObject"]
        Resource = "${aws_s3_bucket.b["documents"].arn}/quarantine/*"
      },
      {
        Sid      = "ReadScannedDocuments"
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:GetObjectTagging"]
        Resource = ["${aws_s3_bucket.b["documents"].arn}/clean/*", "${aws_s3_bucket.b["documents"].arn}/restricted/*"]
      },
      {
        Effect   = "Allow"
        Action   = ["kms:GenerateDataKey", "kms:Decrypt"]
        Resource = [aws_kms_key.data.arn, aws_kms_key.restricted.arn, aws_kms_key.field.arn]
      },
      {
        Effect    = "Allow"
        Action    = ["ses:SendEmail", "ses:SendRawEmail"]
        Resource  = "*"
        Condition = { StringLike = { "ses:FromAddress" = "*@${local.use_domain ? var.domain_name : "example.invalid"}" } }
      },
    ]
  })
}

# Worker task role: promote scanned files, write audit exports, send email.
resource "aws_iam_role" "worker" {
  name               = "${local.name}-worker-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

resource "aws_iam_role_policy" "worker" {
  role = aws_iam_role.worker.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:GetObjectTagging", "s3:DeleteObject"]
        Resource = "${aws_s3_bucket.b["documents"].arn}/quarantine/*"
      },
      {
        Effect   = "Allow"
        Action   = ["s3:PutObject"]
        Resource = ["${aws_s3_bucket.b["documents"].arn}/clean/*", "${aws_s3_bucket.b["documents"].arn}/restricted/*"]
      },
      {
        Effect   = "Allow"
        Action   = ["s3:PutObject"]
        Resource = "${aws_s3_bucket.b["audit"].arn}/*"
      },
      {
        Effect   = "Allow"
        Action   = ["kms:GenerateDataKey", "kms:Decrypt"]
        Resource = [aws_kms_key.data.arn, aws_kms_key.restricted.arn, aws_kms_key.field.arn]
      },
      {
        Effect    = "Allow"
        Action    = ["ses:SendEmail", "ses:SendRawEmail"]
        Resource  = "*"
        Condition = { StringLike = { "ses:FromAddress" = "*@${local.use_domain ? var.domain_name : "example.invalid"}" } }
      },
    ]
  })
}

# ---------- Networking for tasks and ALB ----------
data "aws_ec2_managed_prefix_list" "cloudfront" {
  name = "com.amazonaws.global.cloudfront.origin-facing"
}

resource "aws_security_group" "alb" {
  name        = "${local.name}-alb"
  description = "ALB: HTTPS from CloudFront only"
  vpc_id      = aws_vpc.main.id
  tags        = { Name = "${local.name}-alb" }
}

resource "aws_vpc_security_group_ingress_rule" "alb_from_cloudfront" {
  security_group_id = aws_security_group.alb.id
  prefix_list_id    = data.aws_ec2_managed_prefix_list.cloudfront.id
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  description       = "HTTPS from CloudFront origin-facing IPs"
}

resource "aws_vpc_security_group_egress_rule" "alb_to_tasks" {
  security_group_id            = aws_security_group.alb.id
  referenced_security_group_id = aws_security_group.tasks.id
  ip_protocol                  = "tcp"
  from_port                    = 3000
  to_port                      = 3000
  description                  = "To API tasks"
}

resource "aws_security_group" "tasks" {
  name        = "${local.name}-tasks"
  description = "ECS tasks: API port from ALB; egress HTTPS and Postgres"
  vpc_id      = aws_vpc.main.id
  tags        = { Name = "${local.name}-tasks" }
}

resource "aws_vpc_security_group_ingress_rule" "tasks_from_alb" {
  security_group_id            = aws_security_group.tasks.id
  referenced_security_group_id = aws_security_group.alb.id
  ip_protocol                  = "tcp"
  from_port                    = 3000
  to_port                      = 3000
  description                  = "API from ALB"
}

resource "aws_vpc_security_group_egress_rule" "tasks_https" {
  security_group_id = aws_security_group.tasks.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  description       = "HTTPS to AWS APIs and Google OIDC"
}

resource "aws_vpc_security_group_egress_rule" "tasks_db" {
  security_group_id            = aws_security_group.tasks.id
  referenced_security_group_id = aws_security_group.db.id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  description                  = "Postgres"
}

resource "aws_lb" "api" {
  name                       = "${local.name}-api"
  load_balancer_type         = "application"
  internal                   = false
  subnets                    = aws_subnet.public[*].id
  security_groups            = [aws_security_group.alb.id]
  drop_invalid_header_fields = true
  enable_deletion_protection = local.is_prod
  access_logs {
    bucket  = aws_s3_bucket.b["logs"].id
    prefix  = "alb"
    enabled = true
  }
  depends_on = [aws_s3_bucket_policy.logs_delivery]
}

resource "aws_lb_target_group" "api" {
  name        = "${local.name}-api"
  port        = 3000
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = aws_vpc.main.id
  health_check {
    path                = "/api/health"
    matcher             = "200"
    interval            = 15
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
  deregistration_delay = 20
}

resource "random_password" "origin_secret" {
  length  = 48
  special = false
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.api.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = aws_acm_certificate_validation.origin.certificate_arn
  default_action {
    type = "fixed-response"
    fixed_response {
      content_type = "text/plain"
      message_body = "Forbidden"
      status_code  = "403"
    }
  }
}

# Only requests carrying CloudFront's secret header reach the API.
resource "aws_lb_listener_rule" "from_cloudfront" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 10
  condition {
    http_header {
      http_header_name = "X-Origin-Verify"
      values           = [random_password.origin_secret.result]
    }
  }
  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }
}

# ---------- Task definitions ----------
locals {
  image           = "${aws_ecr_repository.api.repository_url}:${var.image_tag}"
  public_base_url = local.use_domain ? "https://${var.domain_name}" : "https://${aws_cloudfront_distribution.main.domain_name}"
  common_env = [
    { name = "NODE_ENV", value = "production" },
    { name = "AUTH_MODE", value = "google" },
    { name = "PUBLIC_BASE_URL", value = local.public_base_url },
    { name = "GOOGLE_HOSTED_DOMAIN", value = var.google_hosted_domain },
    { name = "NODE_EXTRA_CA_CERTS", value = "/app/certs/rds-global-bundle.pem" },
    { name = "AWS_REGION", value = var.aws_region },
    { name = "DOCUMENTS_BUCKET", value = aws_s3_bucket.b["documents"].id },
    { name = "FIELD_KMS_KEY_ARN", value = aws_kms_key.field.arn },
  ]
  app_secrets = [
    { name = "SESSION_SECRET", valueFrom = "${aws_secretsmanager_secret.app.arn}:SESSION_SECRET::" },
    { name = "GOOGLE_CLIENT_ID", valueFrom = "${aws_secretsmanager_secret.app.arn}:GOOGLE_CLIENT_ID::" },
    { name = "GOOGLE_CLIENT_SECRET", valueFrom = "${aws_secretsmanager_secret.app.arn}:GOOGLE_CLIENT_SECRET::" },
  ]
  container_base = {
    image                  = local.image
    essential              = true
    readonlyRootFilesystem = true
    user                   = "10001"
    linuxParameters        = { initProcessEnabled = true }
    # Read-only root filesystem; /tmp is the only writable path.
    mountPoints = [{ sourceVolume = "tmp", containerPath = "/tmp", readOnly = false }]
  }
}

resource "aws_ecs_task_definition" "api" {
  family                   = "${local.name}-api"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.api_cpu
  memory                   = var.api_memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.api.arn
  runtime_platform {
    cpu_architecture        = "ARM64"
    operating_system_family = "LINUX"
  }
  volume { name = "tmp" }
  container_definitions = jsonencode([merge(local.container_base, {
    name         = "api"
    portMappings = [{ containerPort = 3000, protocol = "tcp" }]
    environment  = concat(local.common_env, [{ name = "PORT", value = "3000" }])
    secrets = concat(local.app_secrets, [
      { name = "DATABASE_URL", valueFrom = "${aws_secretsmanager_secret.db_role["app"].arn}:url::" },
    ])
    healthCheck = {
      # The runtime image has no curl/wget; use Node's fetch.
      command  = ["CMD", "node", "-e", "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
      interval = 15
      retries  = 3
      timeout  = 5
    }
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.app["api"].name
        awslogs-region        = var.aws_region
        awslogs-stream-prefix = "api"
      }
    }
  })])
}

resource "aws_ecs_task_definition" "worker" {
  family                   = "${local.name}-worker"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.worker.arn
  runtime_platform {
    cpu_architecture        = "ARM64"
    operating_system_family = "LINUX"
  }
  volume { name = "tmp" }
  container_definitions = jsonencode([merge(local.container_base, {
    name        = "worker"
    command     = ["node", "dist/worker.js"]
    environment = local.common_env
    secrets = concat(local.app_secrets, [
      { name = "DATABASE_URL", valueFrom = "${aws_secretsmanager_secret.db_role["worker"].arn}:url::" },
    ])
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.app["worker"].name
        awslogs-region        = var.aws_region
        awslogs-stream-prefix = "worker"
      }
    }
  })])
}

# Run by CI before each deploy (design A8): applies migrations as the RDS
# master user and sets the application role passwords from Secrets Manager.
resource "aws_ecs_task_definition" "migrate" {
  family                   = "${local.name}-migrate"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.worker.arn
  runtime_platform {
    cpu_architecture        = "ARM64"
    operating_system_family = "LINUX"
  }
  volume { name = "tmp" }
  container_definitions = jsonencode([merge(local.container_base, {
    name    = "migrate"
    command = ["node", "dist/db/migrate.js"]
    environment = [
      { name = "NODE_ENV", value = "production" },
      { name = "DB_HOST", value = aws_db_instance.main.address },
      { name = "DB_NAME", value = "eureka" },
      { name = "NODE_EXTRA_CA_CERTS", value = "/app/certs/rds-global-bundle.pem" },
    ]
    secrets = [
      { name = "DB_MASTER_USERNAME", valueFrom = "${aws_db_instance.main.master_user_secret[0].secret_arn}:username::" },
      { name = "DB_MASTER_PASSWORD", valueFrom = "${aws_db_instance.main.master_user_secret[0].secret_arn}:password::" },
      { name = "APP_DB_PASSWORD", valueFrom = "${aws_secretsmanager_secret.db_role["app"].arn}:password::" },
      { name = "WORKER_DB_PASSWORD", valueFrom = "${aws_secretsmanager_secret.db_role["worker"].arn}:password::" },
    ]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.app["migrate"].name
        awslogs-region        = var.aws_region
        awslogs-stream-prefix = "migrate"
      }
    }
  })])
}

# ---------- Services ----------
resource "aws_ecs_service" "api" {
  name                   = "api"
  cluster                = aws_ecs_cluster.main.id
  task_definition        = aws_ecs_task_definition.api.arn
  desired_count          = var.api_desired_count
  enable_execute_command = false
  propagate_tags         = "SERVICE"
  capacity_provider_strategy {
    capacity_provider = var.use_fargate_spot ? "FARGATE_SPOT" : "FARGATE"
    weight            = 1
  }
  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.tasks.id]
    assign_public_ip = false
  }
  load_balancer {
    target_group_arn = aws_lb_target_group.api.arn
    container_name   = "api"
    container_port   = 3000
  }
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200
  lifecycle { ignore_changes = [desired_count] }
  depends_on = [aws_lb_listener_rule.from_cloudfront]
}

resource "aws_ecs_service" "worker" {
  name            = "worker"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.worker.arn
  desired_count   = var.worker_desired_count
  propagate_tags  = "SERVICE"
  capacity_provider_strategy {
    capacity_provider = "FARGATE_SPOT"
    weight            = 1
  }
  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.tasks.id]
    assign_public_ip = false
  }
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
}

resource "aws_appautoscaling_target" "api" {
  service_namespace  = "ecs"
  resource_id        = "service/${aws_ecs_cluster.main.name}/${aws_ecs_service.api.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  min_capacity       = var.api_desired_count
  max_capacity       = var.api_max_count
}

resource "aws_appautoscaling_policy" "api_cpu" {
  name               = "${local.name}-api-cpu"
  service_namespace  = "ecs"
  resource_id        = aws_appautoscaling_target.api.resource_id
  scalable_dimension = aws_appautoscaling_target.api.scalable_dimension
  policy_type        = "TargetTrackingScaling"
  target_tracking_scaling_policy_configuration {
    target_value = 60
    predefined_metric_specification { predefined_metric_type = "ECSServiceAverageCPUUtilization" }
  }
}

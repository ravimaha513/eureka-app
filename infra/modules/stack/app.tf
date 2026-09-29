# Compute (design A5 "Compute", A8): ECR, ECS Fargate API and worker, one-off
# migrate task. No load balancer: CloudFront -> API Gateway HTTP API -> VPC link
# -> Cloud Map -> API tasks. At this app's volume that costs cents instead of
# ~$25/month for an ALB and its public IPs.

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
      description  = "Keep last 10 images"
      selection    = { tagStatus = "any", countType = "imageCountMoreThan", countNumber = 10 }
      action       = { type = "expire" }
    }]
  })
}

resource "aws_ecs_cluster" "main" {
  name = local.name
  setting {
    # Container Insights bills custom metrics per task; basic ECS metrics are free.
    name  = "containerInsights"
    value = "disabled"
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
        Effect   = "Allow"
        Action   = ["ssm:GetParameters"]
        Resource = "arn:aws:ssm:${var.aws_region}:${data.aws_caller_identity.current.account_id}:parameter${local.ssm_prefix}/*"
      },
      {
        Effect   = "Allow"
        Action   = ["secretsmanager:GetSecretValue"]
        Resource = [aws_db_instance.main.master_user_secret[0].secret_arn]
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
        Resource = [aws_kms_key.data.arn, aws_kms_key.restricted.arn]
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

# Worker task role. Least privilege: only what the implemented jobs use.
#   audit-export: single-part PutObject (no multipart, so no kms:Decrypt) of
#   audit/*; SSE-KMS with the data key is the bucket default, so the role
#   needs kms:GenerateDataKey on that key, only when called through S3.
# No read, delete or retention-change rights on the audit bucket. Document
# promotion and email grants are added with the jobs that need them (Phase 2).
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
        Sid      = "AuditExportWrite"
        Effect   = "Allow"
        Action   = ["s3:PutObject"]
        Resource = "${aws_s3_bucket.b["audit"].arn}/audit/*"
      },
      {
        Sid      = "AuditExportEncrypt"
        Effect   = "Allow"
        Action   = ["kms:GenerateDataKey"]
        Resource = aws_kms_key.data.arn
        Condition = {
          StringEquals = { "kms:ViaService" = "s3.${var.aws_region}.amazonaws.com" }
          StringLike   = { "kms:EncryptionContext:aws:s3:arn" = "${aws_s3_bucket.b["audit"].arn}*" }
        }
      },
    ]
  })
}

# ---------- Networking: API Gateway HTTP API -> VPC link -> tasks ----------
resource "aws_security_group" "vpc_link" {
  name        = "${local.name}-vpc-link"
  description = "API Gateway VPC link ENIs: to API tasks only"
  vpc_id      = aws_vpc.main.id
  tags        = { Name = "${local.name}-vpc-link" }
}

resource "aws_vpc_security_group_egress_rule" "vpc_link_to_tasks" {
  security_group_id            = aws_security_group.vpc_link.id
  referenced_security_group_id = aws_security_group.tasks.id
  ip_protocol                  = "tcp"
  from_port                    = 3000
  to_port                      = 3000
  description                  = "To API tasks"
}

resource "aws_security_group" "tasks" {
  name        = "${local.name}-tasks"
  description = "ECS tasks: API port from the VPC link only; egress HTTPS and Postgres"
  vpc_id      = aws_vpc.main.id
  tags        = { Name = "${local.name}-tasks" }
}

resource "aws_vpc_security_group_ingress_rule" "tasks_from_vpc_link" {
  security_group_id            = aws_security_group.tasks.id
  referenced_security_group_id = aws_security_group.vpc_link.id
  ip_protocol                  = "tcp"
  from_port                    = 3000
  to_port                      = 3000
  description                  = "API from API Gateway VPC link"
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

# Worker and migrate tasks accept no inbound traffic at all; they only need
# HTTPS (ECR, SSM, Secrets Manager, S3, SES) and Postgres.
resource "aws_security_group" "jobs" {
  name        = "${local.name}-jobs"
  description = "ECS worker and migrate tasks: no ingress; egress HTTPS and Postgres"
  vpc_id      = aws_vpc.main.id
  tags        = { Name = "${local.name}-jobs" }
}

resource "aws_vpc_security_group_egress_rule" "jobs_https" {
  security_group_id = aws_security_group.jobs.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  description       = "HTTPS to AWS APIs"
}

resource "aws_vpc_security_group_egress_rule" "jobs_db" {
  security_group_id            = aws_security_group.jobs.id
  referenced_security_group_id = aws_security_group.db.id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  description                  = "Postgres"
}

# Cloud Map: ECS registers each healthy API task (SRV record carries the port).
resource "aws_service_discovery_private_dns_namespace" "main" {
  name = "${local.name}.local"
  vpc  = aws_vpc.main.id
}

resource "aws_service_discovery_service" "api" {
  name = "api"
  dns_config {
    namespace_id   = aws_service_discovery_private_dns_namespace.main.id
    routing_policy = "MULTIVALUE"
    dns_records {
      type = "SRV"
      ttl  = 10
    }
  }
  # failure_threshold is deprecated (AWS always uses 1); an empty block keeps
  # ECS-reported task health driving registration.
  health_check_custom_config {}
}

resource "aws_apigatewayv2_vpc_link" "api" {
  name               = local.name
  security_group_ids = [aws_security_group.vpc_link.id]
  subnet_ids         = aws_subnet.public[*].id
}

resource "aws_apigatewayv2_api" "api" {
  name          = local.name
  protocol_type = "HTTP"
  description   = "Eureka API origin for CloudFront; requests without the origin secret are rejected by the app"
}

resource "aws_apigatewayv2_integration" "api" {
  api_id                 = aws_apigatewayv2_api.api.id
  integration_type       = "HTTP_PROXY"
  integration_method     = "ANY"
  connection_type        = "VPC_LINK"
  connection_id          = aws_apigatewayv2_vpc_link.api.id
  integration_uri        = aws_service_discovery_service.api.arn
  payload_format_version = "1.0"
  timeout_milliseconds   = 29000
}

# Authorization is done by the application (session + RBAC + RLS), not API Gateway.
resource "aws_apigatewayv2_route" "api" {
  api_id    = aws_apigatewayv2_api.api.id
  route_key = "ANY /api/{proxy+}"
  target    = "integrations/${aws_apigatewayv2_integration.api.id}"
}

resource "aws_cloudwatch_log_group" "apigw" {
  name              = "/eureka/${var.environment}/apigw"
  retention_in_days = var.log_retention_days
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.api.id
  name        = "$default"
  auto_deploy = true
  # Ceiling on request volume (and therefore cost) if the execute-api endpoint
  # is flooded directly. HTTP APIs cannot have WAF, and this limit is shared by
  # all callers, so a direct flood can also throttle real users; see
  # infra/README.md "Known risks" for the ceiling and the mitigation path.
  default_route_settings {
    throttling_burst_limit = 300
    throttling_rate_limit  = 100
  }
  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.apigw.arn
    format = jsonencode({
      requestId        = "$context.requestId", ip = "$context.identity.sourceIp", method = "$context.httpMethod",
      path             = "$context.path", status = "$context.status", latencyMs = "$context.responseLatency",
      integrationError = "$context.integrationErrorMessage"
    })
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
    { name = "FIELD_KMS_KEY_ARN", value = aws_kms_key.restricted.arn },
    # db.t4g.micro allows ~80-110 connections; a rollout can briefly run up to
    # 2 x api_max_count API tasks plus the worker, so keep each pool small.
    { name = "DB_POOL_MAX", value = "5" },
  ]
  app_secrets = [
    { name = "SESSION_SECRET", valueFrom = aws_ssm_parameter.generated["app/session_secret"].arn },
    { name = "GOOGLE_CLIENT_ID", valueFrom = aws_ssm_parameter.google["google_client_id"].arn },
    { name = "GOOGLE_CLIENT_SECRET", valueFrom = aws_ssm_parameter.google["google_client_secret"].arn },
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
  lifecycle {
    precondition {
      condition     = trimspace(var.google_hosted_domain) != ""
      error_message = "google_hosted_domain is empty: set it to the company Google Workspace domain in infra/live/<env>/env.hcl before deploying the API."
    }
  }
  container_definitions = jsonencode([merge(local.container_base, {
    name         = "api"
    portMappings = [{ containerPort = 3000, protocol = "tcp" }]
    environment  = concat(local.common_env, [{ name = "PORT", value = "3000" }])
    # SIGTERM starts a 15 s drain (DRAIN_SECONDS) before the server closes;
    # allow for that plus in-flight requests before ECS sends SIGKILL.
    stopTimeout = 30
    secrets = concat(local.app_secrets, [
      { name = "DATABASE_URL", valueFrom = aws_ssm_parameter.generated["db/app/url"].arn },
      { name = "ORIGIN_VERIFY_SECRET", valueFrom = aws_ssm_parameter.generated["app/origin_secret"].arn },
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
  # The worker gets its own environment: no session secret, OAuth client or
  # document settings (it does not use them). See apps/api/src/worker/config.ts.
  container_definitions = jsonencode([merge(local.container_base, {
    name    = "worker"
    command = ["node", "dist/worker.js"]
    environment = [
      { name = "NODE_ENV", value = "production" },
      { name = "NODE_EXTRA_CA_CERTS", value = "/app/certs/rds-global-bundle.pem" },
      { name = "AWS_REGION", value = var.aws_region },
      { name = "AUDIT_BUCKET", value = aws_s3_bucket.b["audit"].id },
      { name = "DB_POOL_MAX", value = "3" },
      { name = "SHUTDOWN_GRACE_SECONDS", value = "20" },
      { name = "HEARTBEAT_FILE", value = "/tmp/worker-heartbeat" },
    ]
    secrets = [
      { name = "DATABASE_URL", valueFrom = aws_ssm_parameter.generated["db/worker/url"].arn },
    ]
    # SIGTERM gives the running job up to 20 s (SHUTDOWN_GRACE_SECONDS).
    stopTimeout = 30
    # Liveness: the scheduler touches the heartbeat file every tick (60 s).
    healthCheck = {
      command     = ["CMD", "node", "-e", "const s=require('fs').statSync('/tmp/worker-heartbeat');process.exit(Date.now()-s.mtimeMs<300000?0:1)"]
      interval    = 60
      timeout     = 5
      retries     = 3
      startPeriod = 60
    }
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
# No task role: it calls no AWS APIs; its secrets are injected by the execution role.
resource "aws_ecs_task_definition" "migrate" {
  family                   = "${local.name}-migrate"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = aws_iam_role.execution.arn
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
      { name = "APP_DB_PASSWORD", valueFrom = aws_ssm_parameter.generated["db/app/password"].arn },
      { name = "WORKER_DB_PASSWORD", valueFrom = aws_ssm_parameter.generated["db/worker/password"].arn },
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
  # Public subnet + public IP replaces a NAT gateway for egress; inbound is
  # limited to the VPC link by the tasks security group.
  network_configuration {
    subnets          = aws_subnet.public[*].id
    security_groups  = [aws_security_group.tasks.id]
    assign_public_ip = true
  }
  service_registries {
    registry_arn   = aws_service_discovery_service.api.arn
    container_name = "api"
    container_port = 3000
  }
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200
  lifecycle { ignore_changes = [desired_count] }
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
  # Public IP for egress only; the jobs security group has no ingress rules.
  network_configuration {
    subnets          = aws_subnet.public[*].id
    security_groups  = [aws_security_group.jobs.id]
    assign_public_ip = true
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

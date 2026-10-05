# One-time bootstrap (run locally with an admin profile, local state):
#   cd infra/bootstrap && terraform init && terraform apply
# Creates the Terraform state bucket and the GitHub OIDC deploy roles, so CI
# never needs long-lived AWS access keys (design A5, "CI/CD").

terraform {
  required_version = ">= 1.10"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.80" }
  }
}

variable "aws_region" {
  type    = string
  default = "us-east-1"
}

variable "github_repository" {
  description = "owner/repo allowed to assume the deploy roles"
  type        = string
  default     = "ravimaha513/eureka-app"
}

variable "github_subject_prefix" {
  description = "Prefix of the OIDC `sub` claim GitHub issues for this repository. The repo uses immutable subjects (ids, not names): see `gh api repos/<owner>/<repo>/actions/oidc/customization/sub` (sub_claim_prefix)."
  type        = string
  default     = "repo:ravimaha513@4232985/eureka-app@1394148618"
}

variable "create_github_oidc_provider" {
  description = "Set false if the account already has token.actions.githubusercontent.com"
  type        = bool
  default     = true
}

provider "aws" {
  region = var.aws_region
  default_tags {
    tags = { Project = "Eureka", ManagedBy = "Terraform", Environment = "shared" }
  }
}

data "aws_caller_identity" "current" {}

locals {
  account_id   = data.aws_caller_identity.current.account_id
  state_bucket = "eureka-terraform-state-${local.account_id}"
}

# ---------- Terraform state ----------
resource "aws_s3_bucket" "state" {
  bucket = local.state_bucket
  lifecycle { prevent_destroy = true }
}

resource "aws_s3_bucket_versioning" "state" {
  bucket = aws_s3_bucket.state.id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "state" {
  bucket = aws_s3_bucket.state.id
  rule {
    apply_server_side_encryption_by_default { sse_algorithm = "aws:kms" }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_public_access_block" "state" {
  bucket                  = aws_s3_bucket.state.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "state" {
  bucket = aws_s3_bucket.state.id
  rule { object_ownership = "BucketOwnerEnforced" }
}

resource "aws_s3_bucket_policy" "state_tls" {
  bucket = aws_s3_bucket.state.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "DenyInsecureTransport"
      Effect    = "Deny"
      Principal = "*"
      Action    = "s3:*"
      Resource  = [aws_s3_bucket.state.arn, "${aws_s3_bucket.state.arn}/*"]
      Condition = { Bool = { "aws:SecureTransport" = "false" } }
    }]
  })
}

# ---------- GitHub OIDC ----------
resource "aws_iam_openid_connect_provider" "github" {
  count           = var.create_github_oidc_provider ? 1 : 0
  url             = "https://token.actions.githubusercontent.com"
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = ["6938fd4d98bab03faadb97b34396831e3780aea1"]
}

data "aws_iam_openid_connect_provider" "github" {
  count = var.create_github_oidc_provider ? 0 : 1
  url   = "https://token.actions.githubusercontent.com"
}

locals {
  oidc_arn = var.create_github_oidc_provider ? aws_iam_openid_connect_provider.github[0].arn : data.aws_iam_openid_connect_provider.github[0].arn
  # Each role is usable only from its GitHub environment (with required reviewers on production).
  deploy_envs = {
    staging    = "${var.github_subject_prefix}:environment:staging"
    production = "${var.github_subject_prefix}:environment:production"
  }
}

resource "aws_iam_role" "deploy" {
  for_each = local.deploy_envs
  name     = "eureka-github-deploy-${each.key}"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Federated = local.oidc_arn }
      Action    = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = {
          "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
          "token.actions.githubusercontent.com:sub" = each.value
        }
      }
    }]
  })
  max_session_duration = 3600
}

# Terraform needs broad rights to manage the stack; scope to the Eureka project
# via tag conditions where the service supports them, and to this state bucket.
resource "aws_iam_role_policy_attachment" "deploy_power" {
  for_each   = aws_iam_role.deploy
  role       = each.value.name
  policy_arn = "arn:aws:iam::aws:policy/PowerUserAccess"
}

resource "aws_iam_role_policy" "deploy_iam" {
  for_each = aws_iam_role.deploy
  name     = "eureka-iam-scoped"
  role     = each.value.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "ManageEurekaRolesOnly"
        Effect = "Allow"
        Action = ["iam:*Role*", "iam:*RolePolicy*", "iam:PassRole", "iam:*InstanceProfile*", "iam:CreateServiceLinkedRole", "iam:GetPolicy*", "iam:ListPolicies", "iam:TagPolicy", "iam:CreatePolicy*", "iam:DeletePolicy*"]
        Resource = [
          "arn:aws:iam::${local.account_id}:role/eureka-*",
          "arn:aws:iam::${local.account_id}:policy/eureka-*",
          "arn:aws:iam::${local.account_id}:role/aws-service-role/*",
        ]
      },
      {
        Sid      = "DenyDeployRoleSelfEdit"
        Effect   = "Deny"
        Action   = ["iam:*"]
        Resource = "arn:aws:iam::${local.account_id}:role/eureka-github-deploy-*"
      },
    ]
  })
}

output "state_bucket" { value = aws_s3_bucket.state.bucket }
output "deploy_role_arns" { value = { for k, r in aws_iam_role.deploy : k => r.arn } }

# Separate keys limit blast radius (design A5 "Secrets and keys", A6.3).
locals {
  kms_keys = {
    data       = "RDS, general S3 objects, secrets"
    restricted = "Restricted documents (I-9, driving license, work authorization)"
    field      = "Application field encryption data keys (DOB, visa number)"
    logs       = "CloudWatch log groups"
  }
}

data "aws_iam_policy_document" "kms_base" {
  statement {
    sid       = "AccountAdmin"
    actions   = ["kms:*"]
    resources = ["*"]
    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${data.aws_caller_identity.current.account_id}:root"]
    }
  }
}

data "aws_iam_policy_document" "kms_logs" {
  source_policy_documents = [data.aws_iam_policy_document.kms_base.json]
  statement {
    sid       = "CloudWatchLogs"
    actions   = ["kms:Encrypt*", "kms:Decrypt*", "kms:ReEncrypt*", "kms:GenerateDataKey*", "kms:Describe*"]
    resources = ["*"]
    principals {
      type        = "Service"
      identifiers = ["logs.${var.aws_region}.amazonaws.com"]
    }
    condition {
      test     = "ArnLike"
      variable = "kms:EncryptionContext:aws:logs:arn"
      values   = ["arn:aws:logs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:log-group:/eureka/${var.environment}/*"]
    }
  }
}

# Key policy is managed in edge.tf (aws_kms_key_policy.data) because it must
# reference the CloudFront distribution.
resource "aws_kms_key" "data" {
  description         = "${local.name} ${local.kms_keys.data}"
  enable_key_rotation = true
}
resource "aws_kms_alias" "data" {
  name          = "alias/${local.name}-data"
  target_key_id = aws_kms_key.data.id
}

resource "aws_kms_key" "restricted" {
  description         = "${local.name} ${local.kms_keys.restricted}"
  enable_key_rotation = true
  policy              = data.aws_iam_policy_document.kms_base.json
}
resource "aws_kms_alias" "restricted" {
  name          = "alias/${local.name}-restricted"
  target_key_id = aws_kms_key.restricted.id
}

resource "aws_kms_key" "field" {
  description         = "${local.name} ${local.kms_keys.field}"
  enable_key_rotation = true
  policy              = data.aws_iam_policy_document.kms_base.json
}
resource "aws_kms_alias" "field" {
  name          = "alias/${local.name}-field"
  target_key_id = aws_kms_key.field.id
}

resource "aws_kms_key" "logs" {
  description         = "${local.name} ${local.kms_keys.logs}"
  enable_key_rotation = true
  policy              = data.aws_iam_policy_document.kms_logs.json
}
resource "aws_kms_alias" "logs" {
  name          = "alias/${local.name}-logs"
  target_key_id = aws_kms_key.logs.id
}

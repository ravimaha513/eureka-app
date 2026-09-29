# S3 (design A5 "Files", A6.3, A6.4).
#   documents: private; quarantine/ -> clean/ or restricted/ after malware scan
#   audit:     Object Lock (compliance in production) for daily audit exports
#   web:       SPA assets, served only through CloudFront (OAC)
#   logs:      S3 server access logs for the other buckets only (CloudFront
#              standard logs are off; see .checkov.yaml CKV_AWS_86)

locals {
  buckets = {
    documents = "${local.name}-documents-${data.aws_caller_identity.current.account_id}"
    audit     = "${local.name}-audit-${data.aws_caller_identity.current.account_id}"
    web       = "${local.name}-web-${data.aws_caller_identity.current.account_id}"
    logs      = "${local.name}-logs-${data.aws_caller_identity.current.account_id}"
  }
}

resource "aws_s3_bucket" "b" {
  for_each            = local.buckets
  bucket              = each.value
  object_lock_enabled = each.key == "audit"
  force_destroy       = !local.is_prod && each.key != "audit"
}

resource "aws_s3_bucket_public_access_block" "b" {
  for_each                = aws_s3_bucket.b
  bucket                  = each.value.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "b" {
  for_each = aws_s3_bucket.b
  bucket   = each.value.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_versioning" "b" {
  for_each = aws_s3_bucket.b
  bucket   = each.value.id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "b" {
  for_each = aws_s3_bucket.b
  bucket   = each.value.id
  rule {
    apply_server_side_encryption_by_default {
      # Logs bucket uses SSE-S3: S3 server access log delivery cannot use SSE-KMS.
      sse_algorithm     = each.key == "logs" ? "AES256" : "aws:kms"
      kms_master_key_id = each.key == "logs" ? null : aws_kms_key.data.arn
    }
    bucket_key_enabled = each.key != "logs"
  }
}

resource "aws_s3_bucket_logging" "b" {
  for_each      = { for k, v in aws_s3_bucket.b : k => v if k != "logs" }
  bucket        = each.value.id
  target_bucket = aws_s3_bucket.b["logs"].id
  target_prefix = "s3/${each.key}/"
}

# Audit bucket policy (the resource name predates the encryption statements;
# kept to avoid replacing the policy). web, documents and logs have their own
# policies (edge.tf, below) that include the TLS deny.
#
# Encryption: objects must end up under the data key. The worker sends no SSE
# headers and relies on the bucket default (SSE-KMS, data key), so the denies
# only fire when a header IS present and names something else
# (StringNotEqualsIfExists): an explicit other KMS key, a non-KMS algorithm
# such as AES256, or "aws:kms" without a key id (which means aws/s3). A deny
# on a missing header would block the worker.
resource "aws_s3_bucket_policy" "tls_only" {
  for_each = { for k, v in aws_s3_bucket.b : k => v if k == "audit" }
  bucket   = each.value.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "DenyInsecureTransport"
        Effect    = "Deny"
        Principal = "*"
        Action    = "s3:*"
        Resource  = [each.value.arn, "${each.value.arn}/*"]
        Condition = { Bool = { "aws:SecureTransport" = "false" } }
      },
      {
        Sid       = "DenyOtherKmsKey"
        Effect    = "Deny"
        Principal = "*"
        Action    = "s3:PutObject"
        Resource  = "${each.value.arn}/*"
        Condition = { StringNotEqualsIfExists = { "s3:x-amz-server-side-encryption-aws-kms-key-id" = aws_kms_key.data.arn } }
      },
      {
        Sid       = "DenyNonKmsEncryption"
        Effect    = "Deny"
        Principal = "*"
        Action    = "s3:PutObject"
        Resource  = "${each.value.arn}/*"
        Condition = { StringNotEqualsIfExists = { "s3:x-amz-server-side-encryption" = "aws:kms" } }
      },
      {
        # "aws:kms" without a key id selects the AWS-managed aws/s3 key, not the data key.
        Sid       = "DenyKmsWithoutKeyId"
        Effect    = "Deny"
        Principal = "*"
        Action    = "s3:PutObject"
        Resource  = "${each.value.arn}/*"
        Condition = {
          StringEquals = { "s3:x-amz-server-side-encryption" = "aws:kms" }
          Null         = { "s3:x-amz-server-side-encryption-aws-kms-key-id" = "true" }
        }
      },
    ]
  })
  depends_on = [aws_s3_bucket_public_access_block.b]
}

# Restricted documents must be written with the restricted KMS key.
resource "aws_s3_bucket_policy" "documents" {
  bucket = aws_s3_bucket.b["documents"].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "DenyInsecureTransport"
        Effect    = "Deny"
        Principal = "*"
        Action    = "s3:*"
        Resource  = [aws_s3_bucket.b["documents"].arn, "${aws_s3_bucket.b["documents"].arn}/*"]
        Condition = { Bool = { "aws:SecureTransport" = "false" } }
      },
      {
        Sid       = "RestrictedPrefixRequiresRestrictedKey"
        Effect    = "Deny"
        Principal = "*"
        Action    = "s3:PutObject"
        Resource  = "${aws_s3_bucket.b["documents"].arn}/restricted/*"
        Condition = { StringNotEquals = { "s3:x-amz-server-side-encryption-aws-kms-key-id" = aws_kms_key.restricted.arn } }
      },
    ]
  })
  depends_on = [aws_s3_bucket_public_access_block.b]
}

resource "aws_s3_bucket_lifecycle_configuration" "documents" {
  bucket = aws_s3_bucket.b["documents"].id
  rule {
    id     = "expire-quarantine"
    status = "Enabled"
    filter { prefix = "quarantine/" }
    expiration { days = 2 }
    noncurrent_version_expiration { noncurrent_days = 1 }
    abort_incomplete_multipart_upload { days_after_initiation = 1 }
  }
  rule {
    id     = "noncurrent-versions"
    status = "Enabled"
    filter {}
    noncurrent_version_expiration { noncurrent_days = 90 }
    abort_incomplete_multipart_upload { days_after_initiation = 1 }
  }
}

resource "aws_s3_bucket_cors_configuration" "documents" {
  bucket = aws_s3_bucket.b["documents"].id
  cors_rule {
    allowed_methods = ["POST", "GET"]
    allowed_origins = [local.use_domain ? "https://${var.domain_name}" : "https://${aws_cloudfront_distribution.main.domain_name}"]
    allowed_headers = ["*"]
    max_age_seconds = 600
  }
}

resource "aws_s3_bucket_object_lock_configuration" "audit" {
  bucket = aws_s3_bucket.b["audit"].id
  rule {
    default_retention {
      mode = var.audit_lock_mode
      days = var.audit_lock_days
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "logs" {
  bucket = aws_s3_bucket.b["logs"].id
  rule {
    id     = "expire-logs"
    status = "Enabled"
    filter {}
    expiration { days = local.is_prod ? 90 : 14 }
    noncurrent_version_expiration { noncurrent_days = 7 }
    abort_incomplete_multipart_upload { days_after_initiation = 1 }
  }
}

# GuardDuty Malware Protection for S3 scans every object uploaded to quarantine/.
resource "aws_iam_role" "malware_scan" {
  name = "${local.name}-malware-scan"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "malware-protection-plan.guardduty.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy" "malware_scan" {
  role = aws_iam_role.malware_scan.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:GetObjectVersion", "s3:PutObjectTagging", "s3:GetObjectTagging", "s3:PutObjectVersionTagging"]
        Resource = "${aws_s3_bucket.b["documents"].arn}/quarantine/*"
      },
      {
        Effect   = "Allow"
        Action   = ["s3:ListBucket", "s3:GetBucketNotification", "s3:PutBucketNotification", "s3:GetBucketLocation"]
        Resource = aws_s3_bucket.b["documents"].arn
      },
      {
        Effect   = "Allow"
        Action   = ["events:PutRule", "events:DeleteRule", "events:PutTargets", "events:RemoveTargets", "events:DescribeRule"]
        Resource = "arn:aws:events:${var.aws_region}:${data.aws_caller_identity.current.account_id}:rule/DO-NOT-DELETE-AmazonGuardDutyMalwareProtectionS3*"
      },
      {
        Effect   = "Allow"
        Action   = ["kms:GenerateDataKey", "kms:Decrypt"]
        Resource = aws_kms_key.data.arn
      },
    ]
  })
}

resource "aws_guardduty_malware_protection_plan" "documents" {
  role = aws_iam_role.malware_scan.arn
  protected_resource {
    s3_bucket {
      bucket_name     = aws_s3_bucket.b["documents"].id
      object_prefixes = ["quarantine/"]
    }
  }
  actions {
    tagging { status = "ENABLED" }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "web" {
  bucket = aws_s3_bucket.b["web"].id
  rule {
    id     = "old-builds"
    status = "Enabled"
    filter {}
    noncurrent_version_expiration { noncurrent_days = 30 }
    abort_incomplete_multipart_upload { days_after_initiation = 1 }
  }
}

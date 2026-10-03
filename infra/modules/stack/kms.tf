# Three customer-managed keys ($1/month each):
#   data       RDS, S3 objects, ECR, SSM parameters
#   restricted restricted documents (I-9, driving license, work authorization)
#              and application field encryption (DOB, visa number); the
#              encryption context separates the two uses (field data keys
#              carry eureka:purpose = field, and the task roles may use the
#              key directly only with that context).
#   bidx       HMAC key for blind indexes (design A6.3: exact-match lookups on
#              encrypted fields, DOB). GenerateMac only; the key never leaves KMS.
# CloudWatch log groups use the default service encryption: the app never logs
# document contents or restricted fields.

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

# Key policy is managed in edge.tf (aws_kms_key_policy.data) because it must
# reference the CloudFront distribution.
resource "aws_kms_key" "data" {
  description         = "${local.name} data: RDS, S3, ECR, SSM"
  enable_key_rotation = true
}
resource "aws_kms_alias" "data" {
  name          = "alias/${local.name}-data"
  target_key_id = aws_kms_key.data.id
}

resource "aws_kms_key" "restricted" {
  description         = "${local.name} restricted documents and field encryption"
  enable_key_rotation = true
  policy              = data.aws_iam_policy_document.kms_base.json
}
resource "aws_kms_alias" "restricted" {
  name          = "alias/${local.name}-restricted"
  target_key_id = aws_kms_key.restricted.id
}

# HMAC keys cannot rotate automatically: a rotated MAC key would change every
# blind index. Rotation means a new key plus re-indexing (not needed yet:
# nothing writes a blind index until OD-04 is decided).
resource "aws_kms_key" "bidx" {
  #checkov:skip=CKV_AWS_7:HMAC KMS keys do not support automatic rotation; see the comment above
  description              = "${local.name} blind index HMAC"
  key_usage                = "GENERATE_VERIFY_MAC"
  customer_master_key_spec = "HMAC_256"
  policy                   = data.aws_iam_policy_document.kms_base.json
}
resource "aws_kms_alias" "bidx" {
  name          = "alias/${local.name}-bidx"
  target_key_id = aws_kms_key.bidx.id
}

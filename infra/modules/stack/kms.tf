# Two customer-managed keys ($1/month each):
#   data       RDS, S3 objects, ECR, SSM parameters
#   restricted restricted documents (I-9, driving license, work authorization)
#              and application field encryption (DOB, visa number); the
#              encryption context separates the two uses.
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

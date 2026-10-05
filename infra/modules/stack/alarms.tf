# Cost guardrails, part 2: CloudWatch alarms -> SNS -> email (C1a.0).
#
# Three standard-resolution alarms ($0.10/month each beyond the account's 10
# free, which spokenly shares) and email subscriptions (free).
#
# The topics are NOT KMS-encrypted, on purpose. CloudWatch cannot publish to a
# topic encrypted with the AWS-managed alias/aws/sns key, so that choice would
# drop every alarm silently; a customer-managed key costs $1/month per region
# (two regions in staging) to protect messages that carry an alarm name and a
# metric value, nothing more. Same trade-off as the log groups (CKV_AWS_158).

locals {
  # CloudFront metrics exist only in us-east-1, and an alarm can notify only a
  # topic in its own region, so a stack outside us-east-1 needs a second topic.
  alerts_topic_us_east_1 = var.aws_region == "us-east-1" ? aws_sns_topic.alerts.arn : one(aws_sns_topic.alerts_us_east_1[*].arn)
  db_is_burstable        = startswith(var.db_instance_class, "db.t")
}

resource "aws_sns_topic" "alerts" {
  #checkov:skip=CKV_AWS_26:CloudWatch cannot publish to alias/aws/sns; a CMK for alarm names is $1/month (see header)
  name = "${local.name}-alerts"
}

resource "aws_sns_topic_subscription" "alerts_email" {
  for_each  = toset(var.alert_emails)
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = each.value
}

resource "aws_sns_topic" "alerts_us_east_1" {
  #checkov:skip=CKV_AWS_26:CloudWatch cannot publish to alias/aws/sns; a CMK for alarm names is $1/month (see header)
  count    = var.aws_region == "us-east-1" ? 0 : 1
  provider = aws.us_east_1
  name     = "${local.name}-alerts"
}

resource "aws_sns_topic_subscription" "alerts_email_us_east_1" {
  for_each  = var.aws_region == "us-east-1" ? toset([]) : toset(var.alert_emails)
  provider  = aws.us_east_1
  topic_arn = aws_sns_topic.alerts_us_east_1[0].arn
  protocol  = "email"
  endpoint  = each.value
}

check "alert_recipients" {
  assert {
    condition     = length(var.alert_emails) > 0
    error_message = "alert_emails is empty: the cost and RDS alarms will fire into an SNS topic nobody reads."
  }
}

# ---------------- RDS ----------------
# A falling credit balance means sustained CPU above the t4g baseline, which
# unlimited mode bills as surplus credits: the signal to move to db.t4g.small
# (docs/crewnex-consolidation.md section 7, "C2 general").
resource "aws_cloudwatch_metric_alarm" "rds_cpu_credits" {
  count               = local.db_is_burstable ? 1 : 0
  alarm_name          = "${local.name}-rds-cpu-credit-balance-low"
  alarm_description   = "RDS ${aws_db_instance.main.identifier}: CPU credits below ${var.alarm_rds_cpu_credit_balance_min} for 15 minutes; surplus credits are being billed. Consider db.t4g.small."
  namespace           = "AWS/RDS"
  metric_name         = "CPUCreditBalance"
  dimensions          = { DBInstanceIdentifier = aws_db_instance.main.identifier }
  statistic           = "Minimum"
  period              = 300
  evaluation_periods  = 3
  comparison_operator = "LessThanThreshold"
  threshold           = var.alarm_rds_cpu_credit_balance_min
  treat_missing_data  = "missing"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "rds_freeable_memory" {
  alarm_name          = "${local.name}-rds-freeable-memory-low"
  alarm_description   = "RDS ${aws_db_instance.main.identifier}: freeable memory below ${var.alarm_rds_freeable_memory_mb} MiB for 15 minutes."
  namespace           = "AWS/RDS"
  metric_name         = "FreeableMemory"
  dimensions          = { DBInstanceIdentifier = aws_db_instance.main.identifier }
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 3
  comparison_operator = "LessThanThreshold"
  threshold           = var.alarm_rds_freeable_memory_mb * 1024 * 1024
  treat_missing_data  = "missing"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}

# ---------------- CloudFront ----------------
# Global metrics, published in us-east-1 with Region=Global. A daily sum above
# 1/30 of the monthly ceiling means video or a scrape is going out through the
# app distribution: on pay-as-you-go that is $0.085/GB, and on a flat-rate plan
# sustained overuse degrades every user of the distribution.
resource "aws_cloudwatch_metric_alarm" "cloudfront_bytes" {
  provider            = aws.us_east_1
  alarm_name          = "${local.name}-cloudfront-bytes-downloaded-high"
  alarm_description   = "CloudFront ${aws_cloudfront_distribution.main.id}: more than ${ceil(var.alarm_cloudfront_monthly_gb / 30)} GB downloaded in a day (~${var.alarm_cloudfront_monthly_gb} GB/month pace). Video must never be served from this distribution."
  namespace           = "AWS/CloudFront"
  metric_name         = "BytesDownloaded"
  dimensions          = { DistributionId = aws_cloudfront_distribution.main.id, Region = "Global" }
  statistic           = "Sum"
  period              = 86400
  evaluation_periods  = 1
  comparison_operator = "GreaterThanThreshold"
  threshold           = ceil(var.alarm_cloudfront_monthly_gb * 1000 * 1000 * 1000 / 30)
  treat_missing_data  = "notBreaching"
  alarm_actions       = [local.alerts_topic_us_east_1]
  ok_actions          = [local.alerts_topic_us_east_1]
}

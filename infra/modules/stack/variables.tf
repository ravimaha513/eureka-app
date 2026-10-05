variable "project" { type = string }
variable "environment" { type = string }
variable "account_id" { type = string }
variable "aws_region" { type = string }

variable "domain_name" {
  description = "Public hostname for the app (CloudFront). Empty = use the CloudFront default domain."
  type        = string
  default     = ""
}
variable "hosted_zone_name" {
  type    = string
  default = ""
}
variable "google_hosted_domain" {
  description = "Company Google Workspace domain accepted at sign-in (hd claim)."
  type        = string
  default     = ""
}

variable "vpc_cidr" { type = string }
variable "public_subnet_cidrs" { type = list(string) }
variable "private_subnet_cidrs" { type = list(string) }

variable "db_instance_class" { type = string }
variable "db_multi_az" { type = bool }
variable "db_allocated_storage" { type = number }
variable "db_backup_retention_days" { type = number }
variable "db_deletion_protection" { type = bool }

variable "api_cpu" { type = number }
variable "api_memory" { type = number }
variable "api_desired_count" { type = number }
variable "api_max_count" { type = number }
variable "worker_desired_count" { type = number }
variable "feedback_from_email" {
  description = "Verified SES sender for interview feedback. Empty disables feedback mail."
  type        = string
  default     = ""
  validation {
    condition     = var.feedback_from_email == "" || can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", var.feedback_from_email))
    error_message = "feedback_from_email must be empty or an email address."
  }
}
variable "outbox_from_email" {
  description = "Verified SES sender for placement notifications (outbox delivery). Empty disables them."
  type        = string
  default     = ""
  validation {
    condition     = var.outbox_from_email == "" || can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", var.outbox_from_email))
    error_message = "outbox_from_email must be empty or an email address."
  }
}
variable "outbox_deliver_since" {
  description = "RFC 3339 cut-off: unpublished placement events created before it are marked published without email. Set when first enabling outbox mail."
  type        = string
  default     = ""
}
variable "restricted_break_glass_role_arn" {
  description = "IAM role ARN allowed to decrypt with the restricted KMS key besides the API and worker task roles (emergency access, audited by CloudTrail). Empty: nobody else."
  type        = string
  default     = ""
  validation {
    condition     = var.restricted_break_glass_role_arn == "" || can(regex("^arn:aws[a-z-]*:iam::[0-9]{12}:role/.+$", var.restricted_break_glass_role_arn))
    error_message = "restricted_break_glass_role_arn must be empty or an IAM role ARN."
  }
}
variable "use_fargate_spot" { type = bool }

variable "image_tag" {
  description = "API image tag deployed by CI (git SHA)."
  type        = string
  default     = "bootstrap"
}

variable "audit_lock_mode" { type = string }
variable "audit_lock_days" { type = number }
variable "log_retention_days" { type = number }
variable "waf_rate_limit_per_5min" { type = number }

locals {
  name       = "${var.project}-${var.environment}"
  is_prod    = var.environment == "production"
  use_domain = var.domain_name != "" && var.hosted_zone_name != ""
}

# ---------------- Cost guardrails (cost.tf, alarms.tf; infra/README.md "Cost guardrails") ----------------
variable "alert_emails" {
  description = "Addresses that receive budget, cost-anomaly and CloudWatch alarm email. Each SNS subscription must be confirmed from the inbox (hand step)."
  type        = list(string)
  default     = []
  validation {
    condition     = alltrue([for e in var.alert_emails : can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", e))])
    error_message = "alert_emails must contain email addresses only."
  }
}
variable "cost_budgets_enabled" {
  description = "Create the tag-scoped budgets and the cost-anomaly monitor. One environment per account only (production): the Project=Eureka filter already covers every environment, so a second copy would double every email."
  type        = bool
  default     = false
}
variable "cost_allocation_tags_active" {
  description = "The Project tag key is an ACTIVE cost-allocation tag (Billing > Cost allocation tags), activated by this stack or by an Organization payer. Budgets and the anomaly monitor are created only once it is: before activation a TagKeyValue filter cannot see the tag, so the untagged budget would count the whole shared account (spokenly included) and fire on day one."
  type        = bool
  default     = false
  validation {
    condition     = !(var.cost_allocation_tags_active && var.cost_budgets_enabled) || length(var.alert_emails) > 0
    error_message = "Budgets and the anomaly subscription need at least one address in alert_emails."
  }
}
variable "budget_monthly_usd" {
  description = "Monthly budget for Project=Eureka spend, all environments. 40 until cutover; raise to ~60 at C1f (CloudFront Pro $15 + worker)."
  type        = number
  default     = 40
}
variable "budget_crewnex_migration_usd" {
  description = "Monthly budget for Workstream=crewnex: the CrewNex migration tasks only (exporter, import, rehearsal stack), not Eureka's running cost."
  type        = number
  default     = 15
}
variable "budget_untagged_usd" {
  description = "Monthly budget for spend with no Project tag (SES, data transfer, support, tax, and spokenly until it tags itself). Set from the first month's actuals."
  type        = number
  default     = 10
}
variable "cost_anomaly_threshold_usd" {
  description = "Email a Project=Eureka cost anomaly when its total impact is at least this many dollars."
  type        = number
  default     = 10
}
variable "alarm_rds_cpu_credit_balance_min" {
  description = "Alarm when the burstable RDS instance's CPUCreditBalance stays below this for 15 minutes (the cue for db.t4g.small)."
  type        = number
  default     = 50
}
variable "alarm_rds_freeable_memory_mb" {
  description = "Alarm when RDS FreeableMemory stays below this many MiB for 15 minutes."
  type        = number
  default     = 128
}
variable "alarm_cloudfront_monthly_gb" {
  description = "CloudFront egress, in GB per month, that should never happen on this distribution (video or a scrape). Alarmed as a daily sum of one thirtieth of it."
  type        = number
  default     = 1000
}
variable "manage_cost_allocation_tags" {
  description = "This stack activates cost_allocation_tag_keys (aws_ce_cost_allocation_tag). Off until the keys have appeared on BILLED usage (about 24 hours after the first tagged apply): activating an unseen key fails. Leave off if an Organization payer account activates tags instead."
  type        = bool
  default     = false
  validation {
    condition     = !var.manage_cost_allocation_tags || var.cost_budgets_enabled
    error_message = "Activate cost-allocation tags only from the environment that owns the budgets (production): activation is account-wide."
  }
}
variable "cost_allocation_tag_keys" {
  description = "Tag keys to activate when manage_cost_allocation_tags is on. Add Workstream only after the first Workstream=crewnex task has been billed."
  type        = list(string)
  default     = ["Project"]
}
variable "migration_workstream" {
  description = "Value of the Workstream tag carried by the CrewNex migration resources (local.migration_tags); the crewnex-migration budget filters on it."
  type        = string
  default     = "crewnex"
}
variable "migration_log_retention_days" {
  description = "Retention for the CrewNex exporter and import task log groups. Set explicitly, never var.log_retention_days (30 in production)."
  type        = number
  default     = 14
  validation {
    condition     = contains([7, 14], var.migration_log_retention_days)
    error_message = "migration_log_retention_days must be 7 or 14."
  }
}

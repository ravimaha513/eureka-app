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

variable "auth_test_emails" {
  description = "Staging only: comma-separated exact emails outside the hosted domain allowed to sign in (test users). Must be empty in production."
  type        = string
  default     = ""
}

variable "password_login" {
  description = "Staging only: \"on\" enables username and password sign-in for test users. Must be \"off\" in production."
  type        = string
  default     = "off"
  validation {
    condition     = contains(["on", "off"], var.password_login)
    error_message = "password_login must be on or off."
  }
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
# jobs-portal: applicant sign-in links and application notices (the API sends them).
variable "portal_from_email" {
  description = "SES sender for the applicant portal (sign-in links, application notices). Required: the API refuses to start in production without it."
  type        = string
  default     = ""
  validation {
    condition     = var.portal_from_email == "" || can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", var.portal_from_email))
    error_message = "portal_from_email must be empty or an email address."
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

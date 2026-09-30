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

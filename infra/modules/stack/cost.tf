# Cost guardrails, part 1: budgets and anomaly detection (C1a.0;
# docs/crewnex-consolidation.md section 7, infra/README.md "Cost guardrails").
#
# Account 637423353261 is shared with spokenly, so nothing here is
# account-wide: every budget and the anomaly monitor filter on a cost-allocation
# tag. Account-wide budgets or a per-service (DIMENSIONAL) monitor would fire on
# spokenly's spend and train everyone to ignore the email.
#
# Budgets and Cost Explorer are global services; the regional provider is fine.
# They email directly (no SNS topic), which is free.

locals {
  cost_guardrails_on = var.cost_budgets_enabled && var.cost_allocation_tags_active

  # name, limit, TagKeyValue filter ("user:<key>$<value>"; an empty value means
  # "no such tag"), and whether to alert on the forecast as well.
  budget_defs = {
    eureka = {
      name     = "${var.project}-monthly"
      limit    = var.budget_monthly_usd
      filter   = "user:Project$Eureka"
      forecast = true
    }
    crewnex-migration = {
      # Migration tasks only (Workstream=crewnex), not Eureka's running cost.
      name     = "${var.project}-crewnex-migration-tasks"
      limit    = var.budget_crewnex_migration_usd
      filter   = "user:Workstream$crewnex"
      forecast = false
    }
    untagged = {
      name     = "${var.project}-untagged-spend"
      limit    = var.budget_untagged_usd
      filter   = "user:Project$"
      forecast = false
    }
  }
  # A filter, not `cond ? {...} : {}`: those two object types do not unify.
  budgets = { for k, v in local.budget_defs : k => v if local.cost_guardrails_on }

  budget_actual_thresholds = [50, 80, 100]
}

resource "aws_budgets_budget" "cost" {
  for_each     = local.budgets
  depends_on   = [aws_ce_cost_allocation_tag.active]
  name         = each.value.name
  budget_type  = "COST"
  limit_amount = format("%.2f", each.value.limit)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  cost_filter {
    name   = "TagKeyValue"
    values = [each.value.filter]
  }

  dynamic "notification" {
    for_each = local.budget_actual_thresholds
    content {
      comparison_operator        = "GREATER_THAN"
      threshold                  = notification.value
      threshold_type             = "PERCENTAGE"
      notification_type          = "ACTUAL"
      subscriber_email_addresses = var.alert_emails
    }
  }

  dynamic "notification" {
    for_each = each.value.forecast ? [100] : []
    content {
      comparison_operator        = "GREATER_THAN"
      threshold                  = notification.value
      threshold_type             = "PERCENTAGE"
      notification_type          = "FORECASTED"
      subscriber_email_addresses = var.alert_emails
    }
  }
}

# CUSTOM monitor over Project=Eureka only. A SERVICE (DIMENSIONAL) monitor would
# watch the whole account, spokenly included. The expression spells out every
# key because the API returns them and Terraform would otherwise show a diff.
resource "aws_ce_anomaly_monitor" "eureka" {
  count        = local.cost_guardrails_on ? 1 : 0
  name         = "${var.project}-project-tag"
  monitor_type = "CUSTOM"
  monitor_specification = jsonencode({
    And            = null
    CostCategories = null
    Dimensions     = null
    Not            = null
    Or             = null
    Tags = {
      Key          = "Project"
      MatchOptions = null
      Values       = ["Eureka"]
    }
  })
}

# Email subscribers require DAILY or WEEKLY (IMMEDIATE needs SNS).
resource "aws_ce_anomaly_subscription" "eureka" {
  count            = local.cost_guardrails_on ? 1 : 0
  name             = "${var.project}-anomaly-email"
  frequency        = "DAILY"
  monitor_arn_list = [aws_ce_anomaly_monitor.eureka[0].arn]

  threshold_expression {
    dimension {
      key           = "ANOMALY_TOTAL_IMPACT_ABSOLUTE"
      match_options = ["GREATER_THAN_OR_EQUAL"]
      values        = [tostring(var.cost_anomaly_threshold_usd)]
    }
  }

  dynamic "subscriber" {
    for_each = var.alert_emails
    content {
      type    = "EMAIL"
      address = subscriber.value
    }
  }
}

# ---------------- Tag plumbing ----------------
# Provider default_tags put Project=Eureka on everything. The CrewNex migration
# resources (exporter and import task definitions, their log groups, a rehearsal
# stack) add local.migration_tags so the crewnex-migration budget sees them:
#
#   tags = local.migration_tags                     # task definition, log group
#   retention_in_days = var.migration_log_retention_days
#
# and every `aws ecs run-task` of them passes `--propagate-tags TASK_DEFINITION`
# (the caller then needs ecs:TagResource): a standalone Fargate task carries no
# tags otherwise, and its cost lands in the untagged budget instead.
locals {
  migration_tags = { Workstream = var.migration_workstream }
}

# ---------------- Cost-allocation tag activation (opt-in, step 3) ----------------
# Account-wide, so it lives only where the budgets do. Activation fails for a
# key that has not yet appeared on billed usage, takes up to 24 hours to show in
# Cost Explorer and is not retroactive. Destroying this resource DEACTIVATES the
# key for the whole account, spokenly included. In an AWS Organization the payer
# account may have to activate instead (Q35): then leave this off and set
# cost_allocation_tags_active once the payer has done it.
resource "aws_ce_cost_allocation_tag" "active" {
  for_each = var.manage_cost_allocation_tags ? toset(var.cost_allocation_tag_keys) : toset([])
  tag_key  = each.value
  status   = "Active"
}

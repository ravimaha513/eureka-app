# Root Terragrunt configuration (same pattern as spokenly/deployment/terraform).
# State: one bucket per account created by infra/bootstrap; S3-native locking
# (Terraform >= 1.10) instead of a DynamoDB table.

locals {
  account_id = get_aws_account_id()
  env        = read_terragrunt_config("${get_terragrunt_dir()}/env.hcl").locals
}

remote_state {
  backend = "s3"
  generate = {
    path      = "backend.tf"
    if_exists = "overwrite_terragrunt"
  }
  config = {
    bucket       = "eureka-terraform-state-${local.account_id}"
    key          = "${path_relative_to_include()}/terraform.tfstate"
    region       = "us-east-1"
    encrypt      = true
    use_lockfile = true
  }
}

generate "provider" {
  path      = "provider.tf"
  if_exists = "overwrite_terragrunt"
  contents  = <<EOF
provider "aws" {
  region = "${local.env.aws_region}"
  allowed_account_ids = ["${local.env.account_id}"]
  default_tags {
    tags = {
      Project     = "Eureka"
      ManagedBy   = "Terraform"
      Environment = "${local.env.environment}"
      CostCenter  = "Engineering"
      DataClass   = "confidential"
    }
  }
}

# CloudFront certificates and WAF for CloudFront must live in us-east-1.
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"
  allowed_account_ids = ["${local.env.account_id}"]
  default_tags {
    tags = {
      Project     = "Eureka"
      ManagedBy   = "Terraform"
      Environment = "${local.env.environment}"
    }
  }
}
EOF
}

terraform {
  source = "${get_parent_terragrunt_dir()}/modules//stack"
}

inputs = merge({ project = "eureka" }, local.env)

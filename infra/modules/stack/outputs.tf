output "app_url" { value = local.public_base_url }
output "cloudfront_distribution_id" { value = aws_cloudfront_distribution.main.id }
output "web_bucket" { value = aws_s3_bucket.b["web"].id }
output "ecr_repository_url" { value = aws_ecr_repository.api.repository_url }
output "ecs_cluster" { value = aws_ecs_cluster.main.name }
output "migrate_task_definition" { value = aws_ecs_task_definition.migrate.family }
output "public_subnet_ids" { value = aws_subnet.public[*].id }
output "tasks_security_group_id" { value = aws_security_group.tasks.id }
output "db_endpoint" { value = aws_db_instance.main.address }
output "ssm_prefix" {
  description = "Set <prefix>/app/google_client_id and google_client_secret here once."
  value       = local.ssm_prefix
}
output "api_gateway_endpoint" { value = aws_apigatewayv2_api.api.api_endpoint }
output "aws_region" { value = var.aws_region }
output "api_service" { value = aws_ecs_service.api.name }
output "worker_service" { value = aws_ecs_service.worker.name }

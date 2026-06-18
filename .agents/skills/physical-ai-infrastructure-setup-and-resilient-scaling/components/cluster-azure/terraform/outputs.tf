# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

output "resource_group" {
  description = "Resource group name, ID, and location"
  value       = local.resource_group
}

output "key_vault" {
  description = "Key Vault resource details"
  value       = module.platform.key_vault
}

output "key_vault_name" {
  description = "Key Vault name"
  value       = module.platform.key_vault_name
}

output "aks_cluster" {
  description = "AKS cluster resource details"
  value       = module.sil.aks_cluster
  sensitive   = true
}

output "aks_oidc_issuer_url" {
  description = "AKS OIDC issuer URL for workload identity federation"
  value       = module.sil.aks_oidc_issuer_url
}

output "gpu_node_pool_subnets" {
  description = "Subnet IDs for GPU node pools"
  value       = module.sil.gpu_node_pool_subnets
}

output "node_pools" {
  description = "AKS node pool configurations"
  value       = module.sil.node_pools
}

output "azureml_workspace" {
  description = "AzureML workspace resource details"
  value       = module.platform.azureml_workspace
}

output "ml_workload_identity" {
  description = "Managed identity used by AzureML compute"
  value       = module.platform.ml_workload_identity
}

output "postgresql_connection_info" {
  description = "PostgreSQL connection details (null when should_deploy_postgresql = false)"
  value       = module.platform.postgresql_connection_info
  sensitive   = true
}

output "managed_redis_connection_info" {
  description = "Redis connection details (null when should_deploy_redis = false)"
  value       = module.platform.managed_redis_connection_info
  sensitive   = true
}

output "virtual_network" {
  description = "Virtual network resource"
  value       = module.platform.virtual_network
}

output "subnets" {
  description = "All subnet resources"
  value       = module.platform.subnets
}

output "vm_subnet" {
  description = "VM subnet (null when should_create_vm_subnet = false)"
  value       = module.platform.vm_subnet
}

output "network_security_group" {
  description = "Network security group resource"
  value       = module.platform.network_security_group
}

output "private_dns_resolver" {
  description = "Private DNS resolver resource"
  value       = module.platform.private_dns_resolver
}

output "dns_server_ip" {
  description = "DNS server IP for private cluster connectivity"
  value       = module.platform.dns_server_ip
}

output "container_registry" {
  description = "Azure Container Registry resource"
  value       = module.platform.container_registry
}

output "storage_account" {
  description = "Primary storage account"
  value       = module.platform.storage_account
}

output "data_lake_storage_account" {
  description = "Data Lake storage account (null when should_create_data_lake_storage = false)"
  value       = module.platform.data_lake_storage_account
}

output "aml_compute_cluster" {
  description = "AzureML compute cluster (null when should_deploy_aml_compute = false)"
  value       = module.platform.aml_compute_cluster
}

output "log_analytics_workspace" {
  description = "Log Analytics workspace resource"
  value       = module.platform.log_analytics_workspace
}

output "application_insights" {
  description = "Application Insights resource"
  value       = module.platform.application_insights
  sensitive   = true
}

output "grafana" {
  description = "Managed Grafana resource (null when should_deploy_grafana = false)"
  value       = module.platform.grafana
}

output "postgresql" {
  description = "PostgreSQL flexible server resource"
  value       = module.platform.postgresql
}

output "redis" {
  description = "Azure Managed Redis resource"
  value       = module.platform.redis
}

output "osmo_workload_identity" {
  description = "Workload identity for Osmo workflow service account federation"
  value       = module.platform.osmo_workload_identity
}

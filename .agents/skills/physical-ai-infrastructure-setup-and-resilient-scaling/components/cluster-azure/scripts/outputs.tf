# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

output "resource_group" {
  value = azurerm_resource_group.this.name
}

output "aks_name" {
  value = azurerm_kubernetes_cluster.this.name
}

output "pg_fqdn" {
  value = azurerm_postgresql_flexible_server.this.fqdn
}

output "pg_admin_user" {
  value = azurerm_postgresql_flexible_server.this.administrator_login
}

output "pg_admin_password" {
  value     = random_password.pg.result
  sensitive = true
}

output "pg_database" {
  value = azurerm_postgresql_flexible_server_database.osmo.name
}

output "redis_hostname" {
  value = azurerm_managed_redis.this.hostname
}

output "redis_port" {
  value = one(azurerm_managed_redis.this.default_database[*].port)
}

output "redis_primary_key" {
  value     = one(azurerm_managed_redis.this.default_database[*].primary_access_key)
  sensitive = true
}

output "storage_account" {
  value = azurerm_storage_account.this.name
}

output "nfs_storage_account" {
  value = azurerm_storage_account.nfs.name
}

output "storage_account_key" {
  value     = azurerm_storage_account.this.primary_access_key
  sensitive = true
}

output "foundry_resource" {
  value = azurerm_cognitive_account.foundry.name
}

output "foundry_project" {
  value = azurerm_cognitive_account_project.default.name
}

output "foundry_endpoint" {
  value = azurerm_cognitive_account.foundry.endpoint
}

output "key_vault_name" {
  value = azurerm_key_vault.this.name
}

output "location" {
  value = azurerm_resource_group.this.location
}

output "log_analytics_workspace_id" {
  value = azurerm_log_analytics_workspace.this.id
}

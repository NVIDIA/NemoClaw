# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

/**
 * # Robotics Blueprint
 *
 * Deploys robotics infrastructure with NVIDIA GPU support and optional
 * Azure Machine Learning integration. KAI Scheduler is installed downstream
 * by the Azure OSMO component (upstream NVIDIA/OSMO deploy-osmo-minimal.sh).
 *
 * Architecture:
 * - Platform Module: Shared services (networking, security, observability, ACR, storage, ML workspace)
 * - SiL Module: AKS cluster with GPU node pools and ML extension integration
 *
 * Source: extracted from github.com/microsoft/physical-ai-toolchain
 */

locals {
  resource_group_name = coalesce(var.resource_group_name, "rg-${var.resource_prefix}-${var.environment}-${var.instance}")
  current_user_oid    = try(msgraph_resource_action.current_user[0].output.oid, null)
}

resource "msgraph_resource_action" "current_user" {
  count = var.should_add_current_user_key_vault_admin ? 1 : 0
  method       = "GET"
  resource_url = "me"
  response_export_values = {
    oid = "id"
  }
}

resource "azurerm_resource_group" "this" {
  count    = var.should_create_resource_group ? 1 : 0
  name     = local.resource_group_name
  location = var.location
  tags     = var.tags
}

resource "terraform_data" "defer_resource_group" {
  count = var.should_create_resource_group ? 0 : 1
  input = {
    name = local.resource_group_name
  }
}

data "azurerm_resource_group" "existing" {
  count = var.should_create_resource_group ? 0 : 1
  name  = terraform_data.defer_resource_group[0].output.name
}

locals {
  resource_group = var.should_create_resource_group ? {
    id       = azurerm_resource_group.this[0].id
    name     = azurerm_resource_group.this[0].name
    location = azurerm_resource_group.this[0].location
    } : {
    id       = data.azurerm_resource_group.existing[0].id
    name     = data.azurerm_resource_group.existing[0].name
    location = data.azurerm_resource_group.existing[0].location
  }
}

module "platform" {
  source     = "./modules/platform"
  depends_on = [azurerm_resource_group.this]

  environment     = var.environment
  resource_prefix = var.resource_prefix
  location        = var.location
  instance        = var.instance
  resource_group  = local.resource_group
  current_user_oid = local.current_user_oid

  should_enable_nat_gateway = var.should_enable_nat_gateway
  nat_gateway_zones         = var.nat_gateway_zones
  should_create_vm_subnet   = var.should_create_vm_subnet
  virtual_network_config = {
    address_space                  = var.virtual_network_config.address_space
    subnet_address_prefix_main     = var.virtual_network_config.subnet_address_prefix
    subnet_address_prefix_vm       = var.virtual_network_config.subnet_address_prefix_vm
    subnet_address_prefix_pe       = var.virtual_network_config.subnet_address_prefix_pe
    subnet_address_prefix_resolver = var.virtual_network_config.subnet_address_prefix_resolver
  }

  should_enable_private_endpoint          = var.should_enable_private_endpoint
  should_enable_public_network_access     = var.should_enable_public_network_access
  should_add_current_user_key_vault_admin = var.should_add_current_user_key_vault_admin
  should_add_current_user_storage_blob    = var.should_add_current_user_storage_blob
  should_enable_purge_protection          = var.should_enable_purge_protection
  should_create_data_lake_storage         = var.should_create_data_lake_storage

  should_enable_raw_bags_lifecycle_policy           = var.should_enable_raw_bags_lifecycle_policy
  raw_bags_retention_days                           = var.raw_bags_retention_days
  should_enable_converted_datasets_lifecycle_policy = var.should_enable_converted_datasets_lifecycle_policy
  converted_datasets_cool_tier_days                 = var.converted_datasets_cool_tier_days
  should_enable_reports_lifecycle_policy            = var.should_enable_reports_lifecycle_policy
  reports_cool_tier_days                            = var.reports_cool_tier_days
  reports_archive_tier_days                         = var.reports_archive_tier_days

  should_deploy_postgresql = var.should_deploy_postgresql
  should_deploy_redis      = var.should_deploy_redis
  postgresql_config = {
    location                        = coalesce(var.postgresql_location, var.location)
    sku_name                        = var.postgresql_sku_name
    storage_mb                      = var.postgresql_storage_mb
    version                         = var.postgresql_version
    databases                       = var.postgresql_databases
    zone                            = var.postgresql_zone
    should_enable_high_availability = var.postgresql_high_availability.should_enable
    standby_availability_zone       = var.postgresql_high_availability.standby_availability_zone
  }
  redis_config = {
    sku_name                        = var.redis_sku_name
    clustering_policy               = var.redis_clustering_policy
    should_enable_high_availability = var.should_enable_redis_high_availability
  }

  should_enable_osmo_identity     = var.osmo_config.should_enable_identity
  should_deploy_grafana           = var.should_deploy_grafana
  should_deploy_monitor_workspace = var.should_deploy_monitor_workspace
  should_deploy_ampls             = var.should_deploy_ampls
  should_deploy_dce               = var.should_deploy_dce

  should_enable_aml_diagnostic_logs = var.should_enable_aml_diagnostic_logs
  should_deploy_aml_compute         = var.should_deploy_aml_compute
  aml_compute_config                = var.aml_compute_config

  should_include_aks_dns_zone = var.should_include_aks_dns_zone
}

module "sil" {
  source     = "./modules/sil"
  depends_on = [module.platform]

  environment     = var.environment
  resource_prefix = var.resource_prefix
  instance        = var.instance
  location        = var.location
  resource_group  = local.resource_group
  current_user_oid = local.current_user_oid

  virtual_network                 = module.platform.virtual_network
  subnets                         = module.platform.subnets
  network_security_group          = module.platform.network_security_group
  nat_gateway                     = module.platform.nat_gateway
  should_enable_nat_gateway       = var.should_enable_nat_gateway
  log_analytics_workspace         = module.platform.log_analytics_workspace
  monitor_workspace               = module.platform.monitor_workspace
  data_collection_endpoint        = module.platform.data_collection_endpoint
  container_registry              = module.platform.container_registry
  private_dns_zones               = module.platform.private_dns_zones
  should_deploy_monitor_workspace = var.should_deploy_monitor_workspace
  should_deploy_dce               = var.should_deploy_dce

  aks_subnet_config = {
    subnet_address_prefix_aks     = try(var.subnet_address_prefixes_aks[0], null)
    subnet_address_prefix_aks_pod = try(var.subnet_address_prefixes_aks_pod[0], null)
  }

  aks_config = {
    system_node_pool_vm_size                    = var.system_node_pool_vm_size
    system_node_pool_node_count                 = var.system_node_pool_node_count
    should_enable_system_node_pool_auto_scaling = var.should_enable_system_node_pool_auto_scaling
    system_node_pool_min_count                  = var.system_node_pool_min_count
    system_node_pool_max_count                  = var.system_node_pool_max_count
    should_enable_private_cluster               = var.should_enable_private_aks_cluster
    system_node_pool_zones                      = var.system_node_pool_zones
    should_enable_microsoft_defender            = var.should_enable_microsoft_defender
  }

  node_pools             = var.node_pools
  osmo_workload_identity = module.platform.osmo_workload_identity
  osmo_config = {
    should_federate_identity = var.osmo_config.should_federate_identity
    control_plane_namespace  = var.osmo_config.control_plane_namespace
    operator_namespace       = var.osmo_config.operator_namespace
    workflows_namespace      = var.osmo_config.workflows_namespace
  }

  should_enable_private_endpoint = var.should_enable_private_endpoint
}

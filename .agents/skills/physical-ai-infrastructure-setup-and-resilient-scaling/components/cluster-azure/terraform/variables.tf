# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# =============================================================================
# Core
# =============================================================================

variable "environment" {
  type        = string
  description = "Deployment environment: dev, staging, or prod"
}

variable "location" {
  type        = string
  description = "Azure region (e.g. westus3)"
}

variable "resource_prefix" {
  type        = string
  description = "Short prefix applied to all resource names"
}

variable "instance" {
  type        = string
  description = "Instance suffix for multi-environment deployments"
  default     = "001"
}

variable "tags" {
  type        = map(string)
  description = "Tags applied to all resources"
  default     = {}
}

variable "resource_group_name" {
  type        = string
  description = "Override auto-generated resource group name"
  default     = null
}

# =============================================================================
# Resource Group
# =============================================================================

variable "should_create_resource_group" {
  type    = bool
  default = true
}

# =============================================================================
# Identity
# =============================================================================

variable "should_add_current_user_key_vault_admin" {
  type    = bool
  default = true
}

variable "should_add_current_user_storage_blob" {
  type    = bool
  default = true
}

variable "should_enable_purge_protection" {
  type    = bool
  default = false
}

# =============================================================================
# Networking
# =============================================================================

variable "virtual_network_config" {
  type = object({
    address_space                  = string
    subnet_address_prefix          = string
    subnet_address_prefix_vm       = optional(string)
    subnet_address_prefix_pe       = optional(string)
    subnet_address_prefix_resolver = optional(string)
  })
}

variable "subnet_address_prefixes_aks" {
  type    = list(string)
  default = ["10.0.80.0/20"]
}

variable "subnet_address_prefixes_aks_pod" {
  type    = list(string)
  default = ["10.0.96.0/20"]
}

variable "should_enable_nat_gateway" {
  type    = bool
  default = true
}

variable "nat_gateway_zones" {
  type    = list(string)
  default = ["1"]
}

variable "should_create_vm_subnet" {
  type    = bool
  default = false
}

variable "should_enable_private_endpoint" {
  type    = bool
  default = true
}

variable "should_enable_public_network_access" {
  type    = bool
  default = true
}

# =============================================================================
# AKS
# =============================================================================

variable "should_enable_private_aks_cluster" {
  type    = bool
  default = true
}

variable "should_enable_microsoft_defender" {
  type    = bool
  default = false
}

variable "system_node_pool_vm_size" {
  type    = string
  default = "Standard_D16ds_v5"
}

variable "system_node_pool_node_count" {
  type    = number
  default = 3
}

variable "should_enable_system_node_pool_auto_scaling" {
  type    = bool
  default = true
}

variable "system_node_pool_min_count" {
  type    = number
  default = 3
}

variable "system_node_pool_max_count" {
  type    = number
  default = 6
}

variable "system_node_pool_zones" {
  type    = list(string)
  default = null
}

variable "node_pools" {
  type = map(object({
    vm_size                    = string
    subnet_address_prefixes    = list(string)
    node_taints                = optional(list(string), [])
    node_labels                = optional(map(string), {})
    gpu_driver                 = optional(string, "None")
    priority                   = optional(string, "Regular")
    eviction_policy            = optional(string, "Delete")
    should_enable_auto_scaling = optional(bool, true)
    min_count                  = optional(number, 4)
    max_count                  = optional(number, 4)
    node_count                 = optional(number)
    zones                      = optional(list(string))
  }))
  default = {
    gpu = {
      vm_size                    = "Standard_NV36ads_A10_v5"
      subnet_address_prefixes    = ["10.0.112.0/20"]
      node_taints                = ["nvidia.com/gpu:NoSchedule", "kubernetes.azure.com/scalesetpriority=spot:NoSchedule"]
      gpu_driver                 = "None"
      priority                   = "Spot"
      eviction_policy            = "Delete"
      should_enable_auto_scaling = true
      min_count                  = 4
      max_count                  = 4
    }
  }
}

# =============================================================================
# PostgreSQL
# =============================================================================

variable "should_deploy_postgresql" {
  type    = bool
  default = true
}

variable "postgresql_sku_name" {
  type    = string
  default = "GP_Standard_D2s_v3"
}

variable "postgresql_storage_mb" {
  type    = number
  default = 32768
}

variable "postgresql_version" {
  type    = string
  default = "16"
}

variable "postgresql_databases" {
  type = map(object({
    collation = string
    charset   = string
  }))
  description = "Map of databases to create with collation and charset"
  default = {
    osmo = {
      collation = "en_US.utf8"
      charset   = "utf8"
    }
  }
}

variable "postgresql_zone" {
  type    = string
  default = null
}

variable "postgresql_location" {
  type    = string
  default = null
}

variable "postgresql_high_availability" {
  type = object({
    should_enable             = bool
    standby_availability_zone = optional(string)
  })
  default = {
    should_enable             = false
    standby_availability_zone = null
  }
}

# =============================================================================
# Redis
# =============================================================================

variable "should_deploy_redis" {
  type    = bool
  default = true
}

variable "redis_sku_name" {
  type    = string
  default = "Balanced_B10"
}

variable "redis_clustering_policy" {
  type    = string
  default = "EnterpriseCluster"
}

variable "should_enable_redis_high_availability" {
  type    = bool
  default = false
}

# =============================================================================
# Observability
# =============================================================================

variable "should_deploy_grafana" {
  type    = bool
  default = true
}

variable "should_deploy_monitor_workspace" {
  type    = bool
  default = true
}

variable "should_deploy_ampls" {
  type    = bool
  default = true
}

variable "should_deploy_dce" {
  type    = bool
  default = true
}

# =============================================================================
# AzureML
# =============================================================================

variable "should_deploy_aml_compute" {
  type    = bool
  default = false
}

variable "should_enable_aml_diagnostic_logs" {
  type    = bool
  default = false
}

variable "should_include_aks_dns_zone" {
  type    = bool
  default = true
}

variable "aml_compute_config" {
  type = object({
    vm_size        = string
    priority       = string
    min_instances  = number
    max_instances  = number
    idle_time_secs = number
  })
  default = {
    vm_size        = "Standard_NC4as_T4_v3"
    priority       = "LowPriority"
    min_instances  = 0
    max_instances  = 1
    idle_time_secs = 300
  }
}

# =============================================================================
# Storage lifecycle
# =============================================================================

variable "should_create_data_lake_storage" {
  type    = bool
  default = false
}

variable "should_enable_raw_bags_lifecycle_policy" {
  type    = bool
  default = true
}

variable "raw_bags_retention_days" {
  type    = number
  default = 30
}

variable "should_enable_converted_datasets_lifecycle_policy" {
  type    = bool
  default = true
}

variable "converted_datasets_cool_tier_days" {
  type    = number
  default = 90
}

variable "should_enable_reports_lifecycle_policy" {
  type    = bool
  default = true
}

variable "reports_cool_tier_days" {
  type    = number
  default = 30
}

variable "reports_archive_tier_days" {
  type    = number
  default = 180
}

# =============================================================================
# Osmo
# =============================================================================

variable "osmo_config" {
  type = object({
    should_enable_identity   = optional(bool, true)
    should_federate_identity = optional(bool, true)
    control_plane_namespace  = optional(string, "osmo-control-plane")
    operator_namespace       = optional(string, "osmo-operator")
    workflows_namespace      = optional(string, "osmo-workflows")
  })
  default = {
    should_enable_identity   = true
    should_federate_identity = true
    control_plane_namespace  = "osmo-control-plane"
    operator_namespace       = "osmo-operator"
    workflows_namespace      = "osmo-workflows"
  }
}

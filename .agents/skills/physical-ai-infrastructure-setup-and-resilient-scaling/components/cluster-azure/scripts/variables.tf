# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

variable "subscription_id" {
  description = "Azure subscription ID"
  type        = string
}

variable "location" {
  description = "Azure region"
  type        = string
  default     = "eastus2"
}

variable "resource_prefix" {
  description = "Short prefix for all resource names (no spaces)"
  type        = string
  default     = "nvpai"
}

variable "environment" {
  description = "Environment name (dev, staging, prod)"
  type        = string
  default     = "dev"
}

# ---------- Networking ----------

variable "vnet_address_space" {
  description = "VNet address space"
  type        = string
  default     = "10.0.0.0/16"
}

variable "allowed_cidr" {
  description = "CIDRs allowed to access the AKS API server (include your IP/32). No default — must be set."
  type        = list(string)

  validation {
    condition = length(var.allowed_cidr) > 0 && alltrue([
      for cidr in var.allowed_cidr : trimspace(cidr) != "" && cidr != "0.0.0.0/0"
    ])
    error_message = "allowed_cidr must contain one or more CIDRs and must not include 0.0.0.0/0. Include your IP/32."
  }
}

# ---------- AKS ----------

variable "system_vm_size" {
  description = "VM size for AKS system node pool"
  type        = string
  default     = "Standard_D16ds_v5"
}

variable "kubernetes_version" {
  description = "AKS Kubernetes version"
  type        = string
  default     = "1.33"
}

# ---------- GPU Node Pool ----------

variable "gpu_vm_size" {
  description = "VM size for GPU node pool"
  type        = string
  default     = "Standard_NC40ads_H100_v5"
}

variable "gpu_priority" {
  description = "GPU node pool priority (Regular or Spot)"
  type        = string
  default     = "Regular"
}

variable "gpu_min" {
  description = "GPU node pool minimum count"
  type        = number
  default     = 4
}

variable "gpu_max" {
  description = "GPU node pool maximum count"
  type        = number
  default     = 4
}

# ---------- PostgreSQL ----------

variable "pg_sku" {
  description = "PostgreSQL SKU"
  type        = string
  default     = "GP_Standard_D2s_v3"
}

variable "pg_storage_mb" {
  description = "PostgreSQL storage in MB"
  type        = number
  default     = 32768
}

variable "pg_version" {
  description = "PostgreSQL major version"
  type        = string
  default     = "16"
}

# ---------- Tags ----------

variable "tags" {
  description = "Tags applied to all resources"
  type        = map(string)
  default = {
    project    = "nvpai"
    managed-by = "terraform"
  }
}

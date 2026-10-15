# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
terraform {
  required_version = "= 1.12.6"
  required_providers {
    nemoclaw = { source = "registry.opentofu.org/nvidia/nemoclaw" }
  }
}
variable "image" { type = string }
variable "runtime" { type = any }
variable "authenticated" { type = bool }
variable "memory_limit" { type = number }
variable "update_policy" {
  type    = string
  default = null
}
variable "node_selector" {
  type    = map(string)
  default = {}
}
variable "keep_workload" { type = bool }
variable "destroy" { type = bool }
provider "nemoclaw" { destroy = var.destroy }

resource "nemoclaw_kubernetes_storage" "gateway" {
  name                   = "nc-0123456789abcdef-gateway"
  owner                  = "00000000-0000-4000-8000-000000000001"
  generation             = "abcdef0123456789abcdef0123456789"
  compute_driver         = "kubernetes"
  endpoint               = "https://127.0.0.1:17671"
  kubeconfig_env         = "TEST_MODEL_KUBECONFIG"
  context                = "selected"
  namespace              = "agents"
  authentication_profile = "development"
}
locals {
  gateway = {
    layout     = 1
    kind       = "kubernetes_gateway"
    name       = nemoclaw_kubernetes_storage.gateway.name
    owner      = nemoclaw_kubernetes_storage.gateway.owner
    generation = nemoclaw_kubernetes_storage.gateway.generation
    settings = {
      runtime  = { provider = "kubernetes" }
      endpoint = "https://127.0.0.1:17671"
      kubernetes = {
        kubeconfig     = { env = "TEST_MODEL_KUBECONFIG" }
        context        = "selected"
        namespace      = "agents"
        authentication = { profile = "development" }
      }
    }
  }
  identity = {
    layout     = 1
    name       = "nc-0123456789abcdef-model-0123456789abcdef"
    owner      = nemoclaw_kubernetes_storage.gateway.owner
    generation = "0123456789abcdef0123456789abcdef"
    gateway    = local.gateway
  }
}
resource "nemoclaw_kubernetes_service_storage" "model" {
  spec = jsonencode(merge(local.identity, {
    kind          = "kubernetes_service_storage"
    storageGib    = 80
    storageClass  = "model-cache"
    authenticated = var.authenticated
  }))
}
resource "nemoclaw_kubernetes_service" "model" {
  count = var.keep_workload ? 1 : 0
  spec = jsonencode(merge(local.identity, {
    kind            = "kubernetes_service"
    image           = var.image
    imagePullPolicy = "Never"
    runtime         = var.runtime
    architecture    = "amd64"
    sharedMemoryGib = 8
    settings = merge({
      imageMetadata    = { env = "TEST_MODEL_IMAGE_METADATA" }
      cpuRequestMillis = 1000
      cpuLimitMillis   = 4000
      memoryRequestGiB = 32
      memoryLimitGiB   = var.memory_limit
      storageGiB       = 80
      storageClass     = "model-cache"
      nodeSelector     = var.node_selector
    }, var.update_policy == null ? {} : { updatePolicy = var.update_policy })
  }))
  depends_on = [nemoclaw_kubernetes_service_storage.model]
  # The SDK runtime graph adds this postcondition to each model service.
  lifecycle {
    postcondition {
      condition     = self.running == "true"
      error_message = "Managed cluster model reconciliation is incomplete."
    }
  }
}

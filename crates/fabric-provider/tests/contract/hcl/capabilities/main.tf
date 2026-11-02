# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
# An image's capabilities for one Deep Agents configuration, read from the
# fake Docker engine, which serves one image for `image` and no image for a
# reference containing "missing".
terraform {
  required_providers {
    fabric = { source = "registry.opentofu.org/nvidia/fabric" }
  }
}
variable "engine" { type = string }
variable "image" { default = "registry/agent@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }
variable "architecture" { default = "aarch64" }
variable "reads" { default = ["/opt/fabric", "/opt/nemoclaw", "/sandbox"] }
provider "fabric" {}
data "fabric_harnesses" "agent" {
  engine           = var.engine
  image            = var.image
  architecture     = var.architecture
  operating_system = "linux"
  config_json = jsonencode({
    schema_version = "fabric.agent/v1alpha1"
    metadata       = { name = "main" }
    runtime        = {}
    harness        = { adapter_id = "nvidia.fabric.langchain.deepagents" }
    models = {
      default = {
        provider    = "openai"
        model       = "fixture-model"
        base_url    = "http://localhost/v1"
        api_key_env = "MODEL_KEY"
      }
    }
  })
  filesystem_read = var.reads
}
locals {
  binaries = jsondecode(data.fabric_harnesses.agent.binaries_json)
}

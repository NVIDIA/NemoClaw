# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
# Retained credential storage on a fake Docker engine that keeps named
# volumes: one authored identity, and two the providers generate.
terraform {
  required_providers {
    vllm    = { source = "registry.opentofu.org/nvidia/vllm" }
    ollama  = { source = "registry.opentofu.org/nvidia/ollama" }
    fixture = { source = "registry.opentofu.org/nvidia/fixture" }
  }
}
variable "engine" { type = string }
variable "owner" { default = "302ff5e1-088d-42ce-959f-4ff4c3570c13" }
provider "vllm" {}
provider "ollama" {}

resource "vllm_credential_storage" "authored" {
  name       = "nc-0123456789abcdef-inference-qwen-auth"
  owner      = var.owner
  generation = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
  engine     = var.engine
}
resource "vllm_credential_storage" "generated" {
  name   = "generated-credentials"
  engine = var.engine
}
resource "ollama_proxy_credential_storage" "generated" {
  name   = "generated-proxy"
  engine = var.engine
}

# The volumes the engine holds, with how many it has created.
data "fixture_state" "engine" {}
locals {
  engine = jsondecode(data.fixture_state.engine.observations)
}

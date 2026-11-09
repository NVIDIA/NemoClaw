# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
# Host checks an authored configuration reads: an engine's facts, an image's
# compatibility, a container's health by engine state, HTTP, or runtime status
# file, and a model server's readiness by endpoint. Every check only reads.
terraform {
  required_providers {
    host = { source = "registry.opentofu.org/nvidia/host" }
    vllm = { source = "registry.opentofu.org/nvidia/vllm" }
  }
}
variable "engine" { type = string }
# An engine nothing serves.
variable "unreachable_engine" { type = string }
variable "health_url" { type = string }
variable "model_server" { type = string }
variable "sandbox_endpoint" { default = "http://10.0.0.8:18898/v1" }
variable "authentication" { default = null }
provider "host" {}
provider "vllm" {}

data "host_engine" "present" {
  engine = var.engine
}
data "host_engine" "unreachable" {
  engine = var.unreachable_engine
}

data "host_image" "vllm" {
  engine       = var.engine
  image        = "runtime@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  architecture = "arm64"
  labels       = { "org.nemoclaw.backend" = "vllm" }
}

locals {
  health = {
    engine = {}
    http   = { http_url = var.health_url }
    status = { runtime_status = "/data/status.json" }
  }
}
data "host_container_health" "application" {
  for_each       = local.health
  engine         = var.engine
  name           = "application"
  container_id   = "application-id"
  http_url       = lookup(each.value, "http_url", null)
  runtime_status = lookup(each.value, "runtime_status", null)
  labels         = { "nemoclaw.nvidia.com/owner" = "deployment" }
}

data "vllm_runtime" "qwen" {
  hardware {
    profile = "dgx-spark"
  }
  model {
    repository = "Qwen/Qwen3-4B"
    revision   = "1cfa9a7208912126459214e8b04321603b3df60c"
  }
  serving {
    port       = 18898
    model_name = "qwen"
  }
  authentication = var.authentication
}
data "vllm_readiness" "qwen" {
  contract             = data.vllm_runtime.qwen.spec
  wait_timeout_seconds = 2
  endpoint             = "${var.model_server}/v1"
  sandbox_endpoint     = var.sandbox_endpoint
}

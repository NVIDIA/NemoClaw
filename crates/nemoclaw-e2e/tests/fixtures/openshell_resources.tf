# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
terraform {
  required_version = "= 1.12.6"
  required_providers {
    nemoclaw = { source = "registry.opentofu.org/nvidia/nemoclaw" }
  }
}
variable "endpoint" { type = string }
variable "enabled" { default = true }
variable "destroying" { default = false }
variable "image" { default = "fixture@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }
provider "nemoclaw" {
  endpoint = var.endpoint
  destroy  = var.destroying
}
resource "nemoclaw_workspace" "example" {
  name       = "standalone"
  owner      = "standalone-owner"
  generation = "workspace-generation"
  lifecycle { prevent_destroy = true }
}
resource "nemoclaw_provider_profile" "inference" {
  count         = var.enabled ? 1 : 0
  workspace     = nemoclaw_workspace.example.name
  name          = "nemoclaw-inference-local"
  owner         = nemoclaw_workspace.example.owner
  generation    = "provider-generation"
  endpoint      = "http://127.0.0.1:11434/v1"
  authenticated = "false"
}
resource "nemoclaw_provider" "inference" {
  count      = var.enabled ? 1 : 0
  workspace  = nemoclaw_workspace.example.name
  name       = "local"
  owner      = nemoclaw_workspace.example.owner
  generation = "provider-generation"
  endpoint   = nemoclaw_provider_profile.inference[0].endpoint
}
resource "nemoclaw_sandbox" "agent" {
  count         = var.enabled ? 1 : 0
  workspace     = nemoclaw_workspace.example.name
  name          = "assistant"
  owner         = nemoclaw_workspace.example.owner
  generation    = "sandbox-generation"
  image         = var.image
  agent_name    = "assistant"
  agent_runtime = "fabric"
  provider_names_json = jsonencode([nemoclaw_provider.inference[0].name])
}

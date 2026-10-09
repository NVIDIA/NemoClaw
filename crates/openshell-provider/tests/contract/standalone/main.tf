# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
terraform {
  required_version = "= 1.12.6"
  required_providers {
    openshell = { source = "registry.opentofu.org/nvidia/openshell" }
  }
}
variable "endpoint" { type = string }
variable "runtime_json" { type = string }
variable "binaries" { type = list(string) }
variable "enabled" { default = true }
variable "destroying" { default = false }
variable "image" { default = "fixture@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }
provider "openshell" {
  endpoint = var.endpoint
  destroy  = var.destroying
}
resource "openshell_workspace" "example" {
  name       = "standalone"
  owner      = "standalone-owner"
  generation = "workspace-generation"
  lifecycle { prevent_destroy = true }
}
resource "openshell_provider_profile" "inference" {
  count         = var.enabled ? 1 : 0
  workspace     = openshell_workspace.example.name
  name          = "nemoclaw-inference-local"
  owner         = openshell_workspace.example.owner
  generation    = "provider-generation"
  endpoint      = "http://127.0.0.1:11434/v1"
  authenticated = "false"
  binaries      = var.binaries
}
resource "openshell_provider_registration" "inference" {
  count      = var.enabled ? 1 : 0
  workspace  = openshell_workspace.example.name
  name       = "local"
  owner      = openshell_workspace.example.owner
  generation = "provider-generation"
  endpoint   = openshell_provider_profile.inference[0].endpoint
}
resource "openshell_sandbox" "agent" {
  count               = var.enabled ? 1 : 0
  workspace           = openshell_workspace.example.name
  name                = "assistant"
  owner               = openshell_workspace.example.owner
  generation          = "sandbox-generation"
  image               = var.image
  agent_name          = "assistant"
  agent_runtime       = "fabric"
  runtime_json   = var.runtime_json
  provider_names = [openshell_provider_registration.inference[0].name]
  policy {
    managed "nemoclaw-inference-local-fcb7b1f1af3733764900def4" {
      endpoints {
        access = "full"
        allowed_ips = ["127.0.0.1/32"]
        host = "127.0.0.1"
        path = "/v1/**"
        port = 11434
        protocol = "rest"
      }
      name = "nemoclaw-inference-local-fcb7b1f1af3733764900def4"
    }
  }
}

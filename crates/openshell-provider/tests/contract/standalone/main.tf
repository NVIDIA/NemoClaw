# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
terraform {
  required_providers {
    openshell = { source = "registry.opentofu.org/nvidia/openshell" }
  }
}
variable "endpoint" { type = string }
variable "launch_json" { type = string }
variable "binaries" { type = list(string) }
variable "enabled" { default = true }
variable "destroying" { default = false }
variable "image" { default = "fixture@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }
provider "openshell" {
  destroy = var.destroying
}
locals {
  gateway = {
    type                = "openshell_gateway"
    endpoint = var.endpoint
    credential_env      = ""
    tls_ca_env          = ""
    tls_certificate_env = ""
    tls_key_env         = ""
    kubernetes          = ""
  }
}
resource "openshell_workspace" "example" {
  gateway    = local.gateway
  name       = "standalone"
  owner      = "standalone-owner"
  generation = "workspace-generation"
  lifecycle { prevent_destroy = true }
}
resource "openshell_inference" "inference" {
  gateway = local.gateway
  count      = var.enabled ? 1 : 0
  workspace  = openshell_workspace.example.ref
  name       = "local"
  generation = "provider-generation"
  server = {
    type              = "inference_server"
    endpoint          = "http://127.0.0.1:11434/v1"
    model             = ""
    credential_env    = ""
    credential_source = ""
  }
  api      = "openai-completions"
  binaries = var.binaries
}
resource "openshell_sandbox" "agent" {
  gateway = local.gateway
  count               = var.enabled ? 1 : 0
  workspace           = openshell_workspace.example.ref
  name                = "assistant"
  owner               = openshell_workspace.example.owner
  generation          = "sandbox-generation"
  image               = var.image
  launch_json         = var.launch_json
  providers      = [openshell_inference.inference[0].ref]
  policy {
    managed {
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

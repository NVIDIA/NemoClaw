# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
# Sandbox settings passed through to OpenShell: per-driver configuration,
# service exposures and the URLs reported for them, optional providers, and
# a policy's middleware binding.
terraform {
  required_providers {
    openshell = { source = "registry.opentofu.org/nvidia/openshell" }
    fixture   = { source = "registry.opentofu.org/nvidia/fixture" }
  }
}
variable "endpoint" { type = string }
variable "destroying" { default = false }
variable "target" { default = "/sandbox/skills" }
variable "services" {
  type = map(object({
    target_port        = number
    authorization_mode = optional(string)
  }))
  default = {
    research = { target_port = 8080 }
    writer   = { target_port = 7000, authorization_mode = "BEARER_PASSTHROUGH" }
  }
}
provider "openshell" {
  destroy = var.destroying
}
locals {
  gateway = {
    type                = "openshell_gateway"
    endpoint            = var.endpoint
    credential_env      = ""
    tls_ca_env          = ""
    tls_certificate_env = ""
    tls_key_env         = ""
    kubernetes          = ""
  }
  # What the sandbox runs does not matter here.
  launch_json = jsonencode({
    command     = ["/usr/bin/agent"]
    environment = {}
    policy      = { version = 1, network_policies = {} }
    binaries    = ["/usr/bin/agent"]
    metadata    = {}
  })
}
resource "openshell_workspace" "example" {
  gateway    = local.gateway
  name       = "team"
  owner      = "team-owner"
  generation = "workspace-generation"
}
resource "openshell_web_search" "brave" {
  gateway        = local.gateway
  workspace      = openshell_workspace.example.ref
  name           = "brave"
  provider_type  = "brave"
  credential_env = "NEMOCLAW_TEST_BRAVE_KEY"
  binaries       = ["/usr/bin/agent"]
}
resource "openshell_sandbox" "agent" {
  gateway     = local.gateway
  workspace   = openshell_workspace.example.ref
  name        = "researcher"
  owner       = openshell_workspace.example.owner
  generation  = "sandbox-generation"
  image       = "fixture@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  launch_json = local.launch_json
  providers   = [openshell_web_search.brave.ref]
  driver_config = jsonencode({
    docker = {
      mounts      = [{ type = "volume", source = "skills", target = var.target }]
      tmpfs_bytes = 1048576
    }
  })
  # A middleware binding, whose settings reach the gateway as JSON.
  policy {
    explicit {
      version = 1
      network_policies "docs" {
        name = "docs"
        endpoints {
          host     = "docs.example.com"
          port     = 443
          protocol = "rest"
          access   = "read-only"
        }
        binaries {
          path = "/usr/bin/agent"
        }
      }
      network_middlewares "guard" {
        middleware = "decision-guard"
        order      = 10
        on_error   = "fail_closed"
        config     = jsonencode({ mode = "block", terms = ["forbidden"] })
        endpoints {
          include = ["docs.example.com"]
          exclude = ["trusted.example.com"]
        }
      }
    }
  }
  dynamic "service" {
    for_each = var.services
    content {
      name               = service.key
      target_port        = service.value.target_port
      authorization_mode = service.value.authorization_mode
    }
  }
}
# Another resource consumes the reported URLs in the same apply.
resource "terraform_data" "caller" {
  input = openshell_sandbox.agent.service_urls
}
# Sandboxes without providers, omitted or empty.
resource "openshell_sandbox" "omitted" {
  gateway     = local.gateway
  workspace   = openshell_workspace.example.ref
  name        = "omitted"
  owner       = openshell_workspace.example.owner
  generation  = "omitted-generation"
  image       = "fixture@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  launch_json = local.launch_json
  policy {}
}
resource "openshell_sandbox" "empty" {
  gateway     = local.gateway
  workspace   = openshell_workspace.example.ref
  name        = "empty"
  owner       = openshell_workspace.example.owner
  generation  = "empty-generation"
  image       = "fixture@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  launch_json = local.launch_json
  providers   = []
  policy {}
}

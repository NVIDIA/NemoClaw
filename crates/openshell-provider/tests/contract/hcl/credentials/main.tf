# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
# Credentials a sandbox's tools use: a web search provider and an API, each
# owning an OpenShell profile and registration.
terraform {
  required_providers {
    openshell = { source = "registry.opentofu.org/nvidia/openshell" }
    fixture   = { source = "registry.opentofu.org/nvidia/fixture" }
  }
}
variable "endpoint" { type = string }
variable "enabled" { default = true }
variable "sandbox" { default = true }
variable "web_search" { default = true }
variable "destroying" { default = false }
variable "sandbox_env" { default = "BRAVE_SEARCH_API_KEY" }
variable "api_endpoint" { default = "https://booking.example.com/mcp" }
variable "api_credential_env" { default = "NEMOCLAW_TEST_BOOKING_KEY" }
variable "auth_style" { default = null }
variable "header_name" { default = null }
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
}
resource "openshell_workspace" "example" {
  gateway    = local.gateway
  name       = "credentials"
  owner      = "credentials-owner"
  generation = "workspace-generation"
}
resource "openshell_web_search" "brave" {
  count          = var.enabled && var.web_search ? 1 : 0
  gateway        = local.gateway
  workspace      = openshell_workspace.example.ref
  name           = "brave"
  provider_type  = "brave"
  credential_env = "NEMOCLAW_TEST_BRAVE_KEY"
  # Hermes's Brave plugin reads this rather than the default variable.
  sandbox_env = var.sandbox_env
  binaries    = ["/usr/bin/curl"]
}
resource "openshell_api" "booking" {
  count          = var.enabled ? 1 : 0
  gateway        = local.gateway
  workspace      = openshell_workspace.example.ref
  name           = "booking"
  endpoint       = var.api_endpoint
  credential_env = var.api_credential_env
  auth_style     = var.auth_style
  header_name    = var.header_name
  binaries       = ["/usr/bin/curl"]
}
resource "openshell_sandbox" "buyer" {
  count      = var.enabled && var.sandbox ? 1 : 0
  gateway    = local.gateway
  workspace  = openshell_workspace.example.ref
  name       = "buyer"
  owner      = openshell_workspace.example.owner
  generation = "sandbox-generation"
  image      = "fixture@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  # What the sandbox runs does not matter here.
  launch_json = jsonencode({
    command     = ["/usr/bin/curl"]
    environment = {}
    policy      = { version = 1, network_policies = {} }
    binaries    = ["/usr/bin/curl"]
    metadata    = {}
  })
  providers = concat(openshell_web_search.brave[*].ref, openshell_api.booking[*].ref)
  policy {}
}

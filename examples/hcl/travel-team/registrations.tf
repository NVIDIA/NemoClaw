# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

data "openshell_gateway" "current" {
  endpoint                 = var.gateway_endpoint
  required_compute_drivers = ["docker"]
}

# Tear the configuration down with tofu destroy -var destroy=true. To keep the
# workspace instead, add lifecycle { prevent_destroy = true } to it.
resource "openshell_workspace" "team" {
  gateway = local.gateway
  name    = var.workspace
}

# Each sandbox attaches one inference registration, so each agent has exactly
# one model: researchers the local one, the scheduler and buyer the hosted one.
# A registration allows only the executables of the harnesses that use it.
resource "openshell_inference" "local" {
  gateway   = local.gateway
  workspace = openshell_workspace.team.ref
  name      = "local"
  server    = local.local_server
  api       = "openai-completions"
  binaries  = local.model_binaries.local
  # Registered once the model is ready.
  depends_on = [data.ollama_readiness.local]
}

resource "openshell_inference" "frontier" {
  gateway   = local.gateway
  workspace = openshell_workspace.team.ref
  name      = "frontier"
  server    = local.frontier_server
  api       = "openai-completions"
  binaries  = local.model_binaries.frontier
}

# Web search, attached to researchers only.
resource "openshell_web_search" "research" {
  gateway        = local.gateway
  workspace      = openshell_workspace.team.ref
  name           = "research"
  provider_type  = var.search.provider
  credential_env = var.search.credential_env
  # The researchers run Hermes, whose Brave plugin reads its key from
  # BRAVE_SEARCH_API_KEY rather than the default BRAVE_API_KEY.
  sandbox_env = var.search.provider == "brave" ? "BRAVE_SEARCH_API_KEY" : null
  binaries    = local.search_binaries
}

locals {
  booking_rules = concat(
    [for method in ["initialize", "notifications/initialized", "tools/list"] : { method = method, tool = null }],
    [for tool in var.bookings.tools : { method = "tools/call", tool = tool }],
  )
}

# The booking service's credential and MCP policy, attached to the buyer only.
resource "openshell_api" "bookings" {
  gateway        = local.gateway
  workspace      = openshell_workspace.team.ref
  name           = "bookings"
  endpoint       = var.bookings.url
  credential_env = var.bookings.credential_env
  binaries       = local.binaries.buyer

  mcp {
    dynamic "rules" {
      for_each = local.booking_rules
      content {
        allow {
          method = rules.value.method
          dynamic "tool" {
            for_each = rules.value.tool == null ? [] : [rules.value.tool]
            content {
              value = tool.value
            }
          }
        }
      }
    }
  }
}

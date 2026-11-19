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

locals {
  # Each search API's host, how it takes the key, and the only requests the
  # researchers' search tools make.
  search_apis = {
    brave = {
      endpoint    = "https://api.search.brave.com"
      auth_style  = "header"
      header_name = "X-Subscription-Token"
      rules       = [{ method = "GET", path = "/res/v1/web/search" }]
    }
    tavily = {
      endpoint    = "https://api.tavily.com"
      auth_style  = "bearer"
      header_name = null
      rules       = [{ method = "POST", path = "/search" }, { method = "POST", path = "/extract" }]
    }
  }
  search_api = local.search_apis[var.search.provider]
}

# Web search, attached to researchers only.
resource "openshell_api" "research" {
  gateway        = local.gateway
  workspace      = openshell_workspace.team.ref
  name           = "research"
  endpoints      = [local.search_api.endpoint]
  credential_env = var.search.credential_env
  auth_style     = local.search_api.auth_style
  header_name    = local.search_api.header_name
  # The researchers run Hermes, whose Brave plugin reads its key from
  # BRAVE_SEARCH_API_KEY.
  sandbox_env = var.search.provider == "brave" ? "BRAVE_SEARCH_API_KEY" : "TAVILY_API_KEY"
  binaries    = local.search_binaries

  rest {
    dynamic "rules" {
      for_each = local.search_api.rules
      content {
        allow {
          method = rules.value.method
          path   = rules.value.path
        }
      }
    }
  }
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
  endpoints      = [var.bookings.url]
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

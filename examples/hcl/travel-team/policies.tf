# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Each sandbox's network grants beyond its providers. OpenShell already grants
# every attached provider's endpoint (models, web search, and the booking
# service's key) to the executables its registration names, so these grants
# cover only what no provider does: research sources, and the booking
# service's MCP tools. OpenShell denies everything else.

locals {
  urls = {
    for name, url in { bookings = var.bookings.url } :
    name => regex("^(?P<scheme>https?)://(?P<host>[^/:]+)(?::(?P<port>[0-9]+))?(?P<path>/[^?#]*)?$", url)
  }
  endpoints = {
    for name, url in local.urls : name => {
      host = url.host
      # An absent port is null, which tonumber accepts, so fall back explicitly.
      port = url.port != null ? tonumber(url.port) : (url.scheme == "https" ? 443 : 80)
      path = try(trimsuffix(url.path, "/"), "")
      # OpenShell pins a literal IP host to that address in the provider's
      # own policy; a grant on the same endpoint must agree.
      allowed_ips = can(cidrhost("${url.host}/32", 0)) ? ["${url.host}/32"] : null
    }
  }

  # The booking service, over MCP: setup and discovery, and calls to the
  # listed tools only. Hermes can't limit which of a server's tools an agent
  # calls, so this grant is what does.
  bookings_grant = {
    host        = local.endpoints.bookings.host
    port        = local.endpoints.bookings.port
    path        = local.endpoints.bookings.path
    allowed_ips = local.endpoints.bookings.allowed_ips
    protocol    = "mcp"
    rules = concat(
      [for method in ["initialize", "notifications/initialized", "tools/list"] : { method = method, path = null, tool = null }],
      [for tool in var.bookings.tools : { method = "tools/call", path = null, tool = tool }],
    )
  }

  grants = {
    for role, settings in local.roles : role => merge(
      {
        for host in lookup(var.research_sources, role, []) : "${role}-${replace(host, ".", "-")}" => {
          host        = host
          port        = 443
          path        = null
          allowed_ips = null
          protocol    = "rest"
          rules       = [{ method = "GET", path = "/**", tool = null }]
        }
      },
      { for name, grant in { "${role}-bookings" = local.bookings_grant } : name => grant if role == "buyer" },
    )
  }
}

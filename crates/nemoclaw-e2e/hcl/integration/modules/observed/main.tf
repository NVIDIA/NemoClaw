# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# What the fixtures recorded, read at plan time. Agents are keyed by sandbox,
# as the live E2E verifier keys its targets.

terraform {
  required_providers {
    fixture = {
      source = "registry.opentofu.org/nvidia/fixture"
    }
  }
}

data "fixture_state" "now" {}

locals {
  observed = jsondecode(data.fixture_state.now.observations)
  starts = {
    for exec in local.observed.openshell.execs :
    exec.sandbox => merge(exec, { configuration = jsondecode(exec.stdin) })
    if contains(exec.command, "start")
  }
}

output "openshell" {
  description = "RPCs, created registrations and sandboxes, execs, Fabric starts, and workspaces."
  value       = local.observed.openshell
}

output "engine" {
  description = "Endpoint, requests, and volumes."
  value       = local.observed.engine
}

output "http" {
  description = "The inference upstream's endpoint and requests."
  value       = local.observed.http
}

output "registrations" {
  description = "Each created provider registration, by name."
  value       = { for provider in local.observed.openshell.created_providers : provider.name => provider }
}

output "agents" {
  description = "Each created sandbox, by name, with its Fabric start: command and decoded configuration, or null."
  value = {
    for sandbox in local.observed.openshell.created_sandboxes :
    sandbox.name => merge(sandbox, { start = lookup(local.starts, sandbox.name, null) })
  }
}

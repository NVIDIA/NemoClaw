# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# What the fixtures recorded, read at plan time. Agents are keyed by sandbox,
# as the live E2E verifier keys its targets. A test file of an authored
# example applies this module first with declare, to declare the fixtures and
# learn their endpoints, and runs it again to observe.

terraform {
  required_providers {
    fixture = {
      source = "registry.opentofu.org/nvidia/fixture"
    }
    # Unused here; a test file that mocks Docker for an example applies its
    # mock to this module's runs too, under this source.
    docker = {
      source = "registry.opentofu.org/kreuzwerker/docker"
    }
  }
}

variable "declare" {
  description = "A fixture declaration, as the fixtures module's declare output; null declares nothing."
  type        = string
  default     = null
}

variable "baseline" {
  description = "What an earlier run observed, for assertions to compare: a test file passes run.NAME.gateway or run.NAME.openshell, because OpenTofu's assertions cannot reference runs."
  type        = any
  default     = null
}

data "fixture_state" "now" {
  declare = var.declare
}

locals {
  observed = jsondecode(data.fixture_state.now.observations)
  live     = local.observed.openshell.sandboxes
  # The latest start in each sandbox, by sandbox name.
  starts = {
    for name, starts in {
      for exec in local.observed.openshell.execs :
      exec.sandbox => merge(exec, { configuration = jsondecode(exec.stdin) })...
      if contains(exec.command, "start")
    } : name => starts[length(starts) - 1]
  }
  # A replaced sandbox or registration was created again under its name; the
  # latest creation is the one the gateway holds.
  sandboxes = {
    for name, created in { for sandbox in local.observed.openshell.created_sandboxes : sandbox.name => sandbox... } :
    name => created[length(created) - 1] if contains(keys(local.live), name)
  }
  registrations = {
    for name, created in { for provider in local.observed.openshell.created_providers : provider.name => provider... } :
    name => created[length(created) - 1] if contains(local.observed.openshell.registrations, name)
  }
}

output "openshell" {
  description = "Endpoint, RPCs, created and current registrations and sandboxes, execs, Fabric starts, effects, and workspaces."
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
  description = "Each provider registration the gateway holds, by name, as created."
  value       = local.registrations
}

output "agents" {
  description = "Each sandbox the gateway holds, by name, as created, with its latest Fabric start: command and decoded configuration, or null."
  value = {
    for name, sandbox in local.sandboxes :
    name => merge(sandbox, { start = lookup(local.starts, name, null) })
  }
}

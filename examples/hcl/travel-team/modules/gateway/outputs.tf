# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

output "gateway" {
  description = "The gateway's ref, which every OpenShell and Fabric object takes."
  value       = local.gateway
}

output "workspace" {
  description = "The workspace's ref, which names it and its owner."
  value       = openshell_workspace.team.ref
}

output "registrations" {
  description = "The refs of the registrations sandboxes attach: local, frontier, search, and bookings."
  value = {
    local    = openshell_inference.local.ref
    frontier = openshell_inference.frontier.ref
    search   = openshell_web_search.research.ref
    bookings = openshell_api.bookings.ref
  }
}

output "frontier_key_env" {
  description = "The variable sandboxes find the hosted model's key in."
  value       = openshell_inference.frontier.sandbox_env
}

output "booking_rules" {
  description = "The MCP methods and tools the booking registration allows."
  value       = local.booking_rules
}

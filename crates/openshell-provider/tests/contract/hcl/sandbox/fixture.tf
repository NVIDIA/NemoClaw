# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
# What the fake gateway received and holds, read after this module's
# resources change, so a run's assertions see that run's result. `fixture`
# changes the gateway outside OpenTofu, such as
# { change = { interrupt_sandbox = "researcher" } }, in a run targeting this
# data source.
variable "fixture" { default = null }
data "fixture_state" "gateway" {
  declare    = var.fixture == null ? null : jsonencode(var.fixture)
  depends_on = [openshell_workspace.example, openshell_api.search, openshell_sandbox.agent, openshell_sandbox.omitted, openshell_sandbox.empty]
}
locals {
  openshell = jsondecode(data.fixture_state.gateway.observations).openshell
  # Stops and starts the gateway received for sandboxes, in order.
  lifecycle_requests = [for rpc in local.openshell.rpcs : rpc if contains(["StopSandbox", "StartSandbox"], rpc)]
}

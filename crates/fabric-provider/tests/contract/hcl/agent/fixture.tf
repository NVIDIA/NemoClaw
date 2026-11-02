# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
# What the fake gateway received and holds, read after this module's
# resources change, so a run's assertions see that run's result. `fixture`
# changes the gateway outside OpenTofu, such as
# { change = { forget_sandboxes = true } }, in a run targeting this data source.
variable "fixture" { default = null }
data "fixture_state" "gateway" {
  declare    = var.fixture == null ? null : jsonencode(var.fixture)
  depends_on = [openshell_workspace.example, openshell_inference.inference, openshell_sandbox.agent, fabric_agent.agent]
}
locals {
  openshell = jsondecode(data.fixture_state.gateway.observations).openshell
  # Pi runtimes Fabric stopped.
  stops = length([for exec in local.openshell.execs : exec if try(exec.command[1], "") == "stop"])
}

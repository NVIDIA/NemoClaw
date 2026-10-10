# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
# Readiness of the configured agent, read after its configuration applies.
data "fabric_sandbox_readiness" "agent" {
  count         = var.enabled ? 1 : 0
  workspace     = openshell_sandbox.agent[0].workspace
  name          = openshell_sandbox.agent[0].name
  id            = openshell_sandbox.agent[0].id
  owner         = openshell_sandbox.agent[0].owner
  generation    = openshell_sandbox.agent[0].generation
  agent_name    = openshell_sandbox.agent[0].agent_name
  agent_runtime = openshell_sandbox.agent[0].agent_runtime
  runtime_json  = openshell_sandbox.agent[0].runtime_json
  config_json   = fabric_agent_configuration.agent[0].config_json
  read_trigger  = fabric_agent_configuration.agent[0].id
}
output "ready" {
  value = var.enabled ? data.fabric_sandbox_readiness.agent[0].ready : null
}

# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
# Readiness of the configured agent, read after its configuration applies.
data "fabric_sandbox_readiness" "agent" {
  count         = var.enabled ? 1 : 0
  gateway       = local.gateway
  workspace     = openshell_sandbox.agent[0].ref.workspace
  name          = openshell_sandbox.agent[0].name
  id            = openshell_sandbox.agent[0].id
  owner         = openshell_sandbox.agent[0].owner
  generation    = openshell_sandbox.agent[0].generation
  launch_json   = openshell_sandbox.agent[0].launch_json
  config_json = jsonencode({
    schema_version = "fabric.agent/v1alpha1"
    runtime        = {}
    metadata       = { name = fabric_agent.agent[0].name }
    harness        = { adapter_id = local.harness.adapter_id }
    instructions   = { system = { content = "Answer briefly.", mode = var.mode } }
    models         = { default = { provider = "openai", model = var.model, api_key_env = "NEMOCLAW_ANONYMOUS_API_KEY" } }
  })
  read_trigger = fabric_agent.agent[0].id
}
output "ready" {
  value = var.enabled ? data.fabric_sandbox_readiness.agent[0].ready : null
}

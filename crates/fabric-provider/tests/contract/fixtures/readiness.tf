# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
# Readiness of the configured agent, read after it applies.
data "fabric_agent_readiness" "agent" {
  count        = var.enabled ? 1 : 0
  gateway      = local.gateway
  agent        = fabric_agent.agent[0].ref
  read_trigger = fabric_agent.agent[0].id
}
output "ready" {
  value = var.enabled ? data.fabric_agent_readiness.agent[0].ready : null
}

# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

output "agents" {
  description = "What invoking each agent needs: its workspace, sandbox, agent name, and Fabric runtime ID."
  value = {
    for role, agent in fabric_agent.agent : role => {
      workspace  = openshell_workspace.team.name
      sandbox    = openshell_sandbox.agent[role].name
      agent      = agent.name
      runtime_id = agent.runtime_id
    }
  }
}

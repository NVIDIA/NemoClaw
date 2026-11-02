# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
# A Pi agent through the fabric provider under test.

# Valid Fabric configuration plans even when the harness can't apply it, such
# as Pi appending to system instructions: Fabric decides that in the sandbox.
run "plan_appended_instructions" {
  command = plan
  variables { mode = "append" }
}

run "deploy" {}

run "reapply_unchanged" {
  assert {
    condition     = sum(values(local.openshell.fabric_starts)) == 1 && local.stops == 0
    error_message = "Planning must not start Pi, apply starts it once, and an unchanged apply must not restart it."
  }
}

run "remove_agent" {
  variables { agent = false }
  assert {
    condition     = local.stops == 1 && !contains(local.openshell.fabric_configured, openshell_sandbox.agent[0].id)
    error_message = "Removing the agent must stop it and clear its configuration."
  }
  assert {
    condition     = values(local.openshell.sandboxes) == [openshell_sandbox.agent[0].id]
    error_message = "Removing the agent must keep its sandbox."
  }
}

run "add_agent_back" {
  assert {
    condition     = contains(local.openshell.fabric_configured, openshell_sandbox.agent[0].id)
    error_message = "The agent must start again in the same sandbox."
  }
}

run "change_model" {
  variables { model = "second-model" }
  assert {
    condition     = local.stops == 2 && local.openshell.fabric_starts[openshell_sandbox.agent[0].id] == 1 && length(local.openshell.fabric_starts) == 2
    error_message = "A changed agent must stop in its old sandbox and start once in a new one."
  }
}

run "teardown" {
  variables {
    enabled    = false
    destroying = true
  }
  assert {
    condition     = local.stops == 3 && length(local.openshell.sandboxes) == 0
    error_message = "Teardown must stop Pi, then remove its sandbox."
  }
}

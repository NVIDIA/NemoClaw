# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
# A Pi agent through the fabric provider under test. Each observe_ run applies
# the previous run's configuration again, so it changes nothing, and reads the
# fake gateway through data.fixture_state.gateway.

# Valid Fabric configuration plans even when the harness can't apply it, such
# as Pi appending to system instructions: Fabric decides that in the sandbox.
run "plan_appended_instructions" {
  command = plan
  variables { mode = "append" }
}

run "deploy" {}

run "reapply_unchanged" {}

run "observe_deployed" {
  assert {
    condition     = local.gateway_state.fabric.writes == 1
    error_message = "Planning must not start Pi, apply starts it once, and an unchanged apply must not restart it: ${local.gateway_state.fabric.writes} starts and stops."
  }
}

run "change_model" {
  variables { model = "second-model" }
}

run "observe_changed" {
  variables { model = "second-model" }
  assert {
    condition     = local.gateway_state.fabric.writes == 3
    error_message = "The change must stop Pi once and start it once: ${local.gateway_state.fabric.writes} starts and stops."
  }
  assert {
    condition     = length(local.gateway_state.fabric.stopped) == 1 && !contains(local.gateway_state.fabric.stopped, openshell_sandbox.agent[0].id)
    error_message = "A changed agent must stop in its old sandbox and run in a new one."
  }
}

run "remove_agent" {
  variables {
    model = "second-model"
    agent = false
  }
}

run "observe_removed" {
  variables {
    model = "second-model"
    agent = false
  }
  assert {
    condition     = contains(local.gateway_state.fabric.stopped, openshell_sandbox.agent[0].id)
    error_message = "Removing the agent must stop it."
  }
  assert {
    condition     = !contains(local.gateway_state.fabric.configured, openshell_sandbox.agent[0].id)
    error_message = "Removing the agent must clear its configuration."
  }
  assert {
    condition     = [for sandbox in values(local.gateway_state.sandboxes) : sandbox.id] == [openshell_sandbox.agent[0].id]
    error_message = "Removing the agent must keep its sandbox."
  }
}

run "add_agent_back" {
  variables { model = "second-model" }
}

run "observe_added_back" {
  variables {
    model = "second-model"
  }
  assert {
    condition     = contains(local.gateway_state.fabric.configured, openshell_sandbox.agent[0].id)
    error_message = "The agent must start again in the same sandbox."
  }
}

run "teardown" {
  variables {
    model      = "second-model"
    enabled    = false
    destroying = true
  }
}

run "observe_teardown" {
  variables {
    enabled    = false
    destroying = true
  }
  assert {
    condition     = local.gateway_state.fabric.writes == 6 && length(local.gateway_state.sandboxes) == 0
    error_message = "Teardown must stop Pi once, then remove its sandbox."
  }
}

# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
# Changes made inside the sandbox, outside OpenTofu. Fabric reports no applied
# configuration, so a model changed there is not drift. A runtime that
# stopped starts again in the same sandbox, as does one whose sandbox its
# platform stopped, once the sandbox restarts in place.

run "deploy" {}

run "change_model_inside" {
  variables { fixture = { change = { change_agent_model = "assistant" } } }
  plan_options { target = [data.fixture_state.gateway] }
}

run "model_change_is_not_drift" {
  assert {
    condition     = sum(values(local.openshell.fabric_starts)) == 1 && local.stops == 0
    error_message = "A model changed inside the sandbox must not restart or replace the agent."
  }
}

run "stop_runtime" {
  variables { fixture = { change = { stop_agent_runtime = "assistant" } } }
  plan_options { target = [data.fixture_state.gateway] }
}

run "restart" {
  assert {
    condition     = sum(values(local.openshell.fabric_starts)) == 2 && length(local.openshell.fabric_starts) == 1 && length(local.openshell.created_sandboxes) == 1
    error_message = "A stopped runtime must start again in the same sandbox."
  }
}

run "interrupt_sandbox" {
  variables { fixture = { change = { interrupt_sandbox = "assistant" } } }
  plan_options { target = [data.fixture_state.gateway] }
}

run "restart_sandbox" {
  assert {
    condition     = length(local.openshell.created_sandboxes) == 1 && local.openshell.sandbox_deletes == 0
    error_message = "A sandbox its platform stopped must restart in place, not be replaced."
  }
  assert {
    condition     = sum(values(local.openshell.fabric_starts)) == 3 && length(local.openshell.fabric_starts) == 1
    error_message = "The agent must start again in its restarted sandbox."
  }
}

run "teardown" {
  variables {
    enabled    = false
    destroying = true
  }
}

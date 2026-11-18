# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
# After provider errors, Fabric marks a runtime failed but leaves its processes
# running, and they hold the agent's native ports. Apply stops the failed
# runtime before it starts another in the same sandbox.

run "deploy" {}

run "fail_runtime" {
  variables { fixture = { change = { fail_agent_runtime = "assistant" } } }
  plan_options { target = [data.fixture_state.gateway] }
}

run "replace_failed_runtime" {
  assert {
    condition     = local.stops == 1
    error_message = "Apply must stop the failed runtime."
  }
  assert {
    condition     = sum(values(local.openshell.fabric_starts)) == 2 && length(local.openshell.created_sandboxes) == 1
    error_message = "Apply must start another runtime in the same sandbox."
  }
  assert {
    condition     = fabric_agent.agent[0].running == "true"
    error_message = "The new runtime must be recorded as running."
  }
}

run "teardown" {
  variables {
    enabled    = false
    destroying = true
  }
}

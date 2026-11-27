# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
# A sandbox that ran and that its platform stopped without a main-process
# result, as when its Kubernetes Pod is deleted, restarts in place: OpenShell
# stops and starts it, keeping its identity. One whose main process exited is
# replaced.

run "deploy" {}

run "interrupt" {
  variables { fixture = { change = { interrupt_sandbox = "researcher" } } }
  plan_options { target = [data.fixture_state.gateway] }
}

run "restart_in_place" {
  assert {
    condition     = length(local.openshell.created_sandboxes) == 3 && local.openshell.sandbox_deletes == 0
    error_message = "A sandbox its platform stopped must restart in place, not be replaced: ${jsonencode(local.openshell.created_sandboxes)}"
  }
  assert {
    condition     = local.lifecycle_requests == ["StopSandbox", "StartSandbox"]
    error_message = "The restart must stop the sandbox, then start it: ${jsonencode(local.lifecycle_requests)}"
  }
  assert {
    condition     = length(openshell_sandbox.agent.service_urls) == 2 && openshell_sandbox.agent.policy_hash != ""
    error_message = "The restarted sandbox must keep its services and load its policy again."
  }
}

run "unchanged" {
  assert {
    condition     = length(local.lifecycle_requests) == 2 && length(local.openshell.created_sandboxes) == 3
    error_message = "A sandbox that runs again must not restart again."
  }
}

run "exit" {
  variables { fixture = { change = { exit_sandbox = "researcher" } } }
  plan_options { target = [data.fixture_state.gateway] }
}

run "replace_after_exit" {
  assert {
    condition     = length(local.openshell.created_sandboxes) == 4 && local.openshell.sandbox_deletes == 1
    error_message = "A sandbox whose main process exited must be replaced."
  }
  assert {
    condition     = length(local.lifecycle_requests) == 2
    error_message = "A replaced sandbox must not be restarted."
  }
}

# Teardown mode lets the test's cleanup delete the workspace.
run "teardown" {
  variables { destroying = true }
}

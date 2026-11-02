# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
# Authored OpenShell resources without the SDK: an inference registration and
# the sandbox that attaches it.

# Planning new objects reaches no gateway, so one configuration can plan a
# gateway installation together with the objects it will serve.
run "plan_before_the_gateway_exists" {
  command = plan
  variables { endpoint = "http://127.0.0.1:9" }
}

run "deploy" {
  assert {
    condition     = keys(local.openshell.profiles) == ["nemoclaw-inference-local"] && local.openshell.registrations == ["local"]
    error_message = "The inference resource must own one profile and one registration."
  }
  assert {
    condition     = [for sandbox in local.openshell.created_sandboxes : sandbox.providers] == [["local"]]
    error_message = "The sandbox must attach the registration."
  }
}

run "reapply_unchanged" {
  assert {
    condition     = local.openshell.effects == 4
    error_message = "Only the four creations may change the gateway, not planning or an unchanged apply: ${local.openshell.effects} changes."
  }
}

# Confirmed absence is recreated without replacing the sandbox that attaches
# the registration.
run "lose_registration" {
  variables { fixture = { change = { forget_registrations = true } } }
  plan_options { target = [data.fixture_state.gateway] }
}

run "recreate_registration" {
  assert {
    condition     = local.openshell.registrations == ["local"] && length(local.openshell.profiles) == 1 && length(local.openshell.created_providers) == 2
    error_message = "A missing registration must be created again with its profile."
  }
  assert {
    condition     = length(local.openshell.created_sandboxes) == 1
    error_message = "Recreating a registration must keep the sandbox that attaches it."
  }
}

# Replacing the inference resource for a missing profile would delete the
# registration the sandbox attaches, so the profile is recreated in place.
run "lose_profile" {
  variables { fixture = { change = { forget_profiles = true } } }
  plan_options { target = [data.fixture_state.gateway] }
}

run "recreate_profile" {
  assert {
    condition     = length(local.openshell.profiles) == 1 && length(local.openshell.created_providers) == 2 && length(local.openshell.created_sandboxes) == 1
    error_message = "A missing profile must be created again, keeping the registration and sandbox."
  }
}

run "lose_sandbox" {
  variables { fixture = { change = { forget_sandboxes = true } } }
  plan_options { target = [data.fixture_state.gateway] }
}

run "recreate_sandbox" {
  assert {
    condition     = length(local.openshell.sandboxes) == 1 && length(local.openshell.created_sandboxes) == 2
    error_message = "A missing sandbox must be created again."
  }
}

run "change_image" {
  variables { image = "fixture@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }
  assert {
    condition     = length(local.openshell.sandboxes) == 1 && length(local.openshell.created_sandboxes) == 3
    error_message = "A changed image must replace the sandbox."
  }
}

# Without teardown mode, removed objects are deleted and the workspace stays.
run "remove" {
  variables { enabled = false }
  assert {
    condition     = length(local.openshell.sandboxes) + length(local.openshell.registrations) + length(local.openshell.profiles) == 0
    error_message = "Removing the resources must delete their objects."
  }
  assert {
    condition     = local.openshell.workspaces == ["standalone"]
    error_message = "Removing the resources must keep the workspace."
  }
}

# Teardown mode lets the test's cleanup delete the workspace.
run "teardown" {
  variables {
    enabled    = false
    destroying = true
  }
}

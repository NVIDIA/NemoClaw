# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
# Authored OpenShell resources without the SDK: an inference registration and
# the sandbox that attaches it. Each observe_ run applies the previous run's
# configuration again, so it changes nothing, and reads the fake gateway.

# Planning new objects reaches no gateway, so one configuration can plan a
# gateway installation together with the objects it will serve.
run "plan_before_the_gateway_exists" {
  command = plan
  variables { endpoint = "http://127.0.0.1:9" }
}

run "deploy" {}

run "observe_deployed" {
  assert {
    condition     = keys(local.gateway_state.profiles) == ["standalone/nemoclaw-inference-local"] && keys(local.gateway_state.providers) == ["standalone/local"]
    error_message = "The inference resource must own one profile and one registration."
  }
  assert {
    condition     = [for sandbox in values(local.gateway_state.sandboxes) : sandbox.providers] == [["local"]]
    error_message = "The sandbox must attach the registration."
  }
  assert {
    condition     = local.gateway_state.effects == 4
    error_message = "Only the four creations may change the gateway, not planning or an unchanged apply: ${local.gateway_state.effects} changes."
  }
}

# Confirmed absence is recreated without replacing the sandbox that attaches
# the registration.
run "lose_registration" {
  variables { fixture = { remove = ["providers"] } }
  plan_options { target = [data.fixture_state.gateway] }
}

run "recreate_registration" {}

run "observe_recreated_registration" {
  assert {
    condition     = length(local.gateway_state.providers) == 1 && length(local.gateway_state.profiles) == 1 && local.gateway_state.created.providers == 2
    error_message = "A missing registration must be created again with its profile."
  }
  assert {
    condition     = local.gateway_state.created.sandboxes == 1
    error_message = "Recreating a registration must keep the sandbox that attaches it."
  }
}

# Replacing the inference resource for a missing profile would delete the
# registration the sandbox attaches, so the profile is recreated in place.
run "lose_profile" {
  variables { fixture = { remove = ["profiles"] } }
  plan_options { target = [data.fixture_state.gateway] }
}

run "recreate_profile" {}

run "observe_recreated_profile" {
  assert {
    condition     = length(local.gateway_state.profiles) == 1 && local.gateway_state.created.providers == 2 && local.gateway_state.created.sandboxes == 1
    error_message = "A missing profile must be created again, keeping the registration and sandbox."
  }
}

run "lose_sandbox" {
  variables { fixture = { remove = ["sandboxes"] } }
  plan_options { target = [data.fixture_state.gateway] }
}

run "recreate_sandbox" {}

run "change_image" {
  variables { image = "fixture@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }
}

run "observe_changed_image" {
  variables { image = "fixture@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }
  assert {
    condition     = length(local.gateway_state.sandboxes) == 1 && local.gateway_state.created.sandboxes == 3
    error_message = "A missing sandbox and a changed image must each create one sandbox in its place."
  }
}

# Without teardown mode, removed objects are deleted and the workspace stays.
run "remove" {
  variables { enabled = false }
}

run "observe_removed" {
  variables {
    enabled    = false
    destroying = true
  }
  assert {
    condition     = length(local.gateway_state.sandboxes) + length(local.gateway_state.providers) + length(local.gateway_state.profiles) == 0
    error_message = "Removing the resources must delete their objects."
  }
  assert {
    condition     = local.gateway_state.workspaces == ["standalone"]
    error_message = "Removing the resources must keep the workspace."
  }
}

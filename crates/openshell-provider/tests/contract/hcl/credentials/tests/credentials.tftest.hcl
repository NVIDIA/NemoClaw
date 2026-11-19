# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
# API credentials, with REST or MCP rules: each resource owns a profile and the
# registration that holds the key, and recovers either one without replacing
# the sandbox that attaches it.

run "deploy" {
  assert {
    condition = local.openshell.profiles["nemoclaw-api-search"] == {
      inference_capable = false
      credentials       = [{ env_vars = ["BRAVE_SEARCH_API_KEY"], auth_style = "header", header_name = "X-Subscription-Token" }]
      endpoints         = ["api.search.brave.com:443"]
      binaries          = ["/usr/bin/curl"]
    }
    error_message = "The search profile must send its key in Brave's header to the host its rules restrict."
  }
  assert {
    condition     = local.openshell.registration_credentials["search"] == { BRAVE_SEARCH_API_KEY = "env:NEMOCLAW_TEST_BRAVE_KEY" }
    error_message = "The search registration must hold the key under the variable sandboxes see."
  }
  assert {
    condition = local.openshell.profiles["nemoclaw-api-booking"] == {
      inference_capable = false
      credentials       = [{ env_vars = ["NEMOCLAW_API_BOOKING_KEY"], auth_style = "bearer", header_name = "Authorization" }]
      endpoints         = ["booking.example.com:443/mcp/**"]
      binaries          = ["/usr/bin/curl"]
    }
    error_message = "The API profile must bind its bearer key to its endpoint and binaries."
  }
  assert {
    condition     = local.openshell.registration_credentials["booking"] == { NEMOCLAW_API_BOOKING_KEY = "env:NEMOCLAW_TEST_BOOKING_KEY" }
    error_message = "The API registration must hold the key."
  }
  assert {
    condition     = !strcontains(jsonencode(openshell_api.booking[0]), "booking-fixture-secret")
    error_message = "OpenTofu state must not hold the key."
  }
}

run "lose_profiles" {
  variables { fixture = { change = { forget_profiles = true } } }
  plan_options { target = [data.fixture_state.gateway] }
}

run "recreate_profiles" {}

run "lose_registrations" {
  variables { fixture = { change = { forget_registrations = true } } }
  plan_options { target = [data.fixture_state.gateway] }
}

run "recreate_registrations" {
  assert {
    condition     = length(local.openshell.profiles) == 2 && length(local.openshell.created_providers) == 4
    error_message = "Missing profiles must be recreated in place, and missing registrations created again."
  }
  assert {
    condition     = length(local.openshell.created_sandboxes) == 1
    error_message = "Recovering credentials must keep the sandbox that attaches them."
  }
}

run "rotate_api_key" {
  variables { api_credential_env = "NEMOCLAW_TEST_BOOKING_NEXT" }
  assert {
    condition     = local.openshell.registration_credentials["booking"] == { NEMOCLAW_API_BOOKING_KEY = "env:NEMOCLAW_TEST_BOOKING_NEXT" } && length(local.openshell.created_providers) == 4
    error_message = "Rotating the key's variable must update the registration in place."
  }
}

# Removing a sandbox is a teardown.
run "remove_sandbox" {
  variables {
    api_credential_env = "NEMOCLAW_TEST_BOOKING_NEXT"
    sandbox            = false
    destroying         = true
  }
}

# A key sent in a named header, set without a sandbox: the change replaces
# the registration, which a sandbox would still attach.
run "custom_header" {
  variables {
    sandbox     = false
    auth_style  = "header"
    header_name = "X-Booking-Key"
  }
  assert {
    condition     = local.openshell.profiles["nemoclaw-api-booking"].credentials[0].header_name == "X-Booking-Key"
    error_message = "The key must be sent in the named header."
  }
}

# One key for two hosts, in the variable the sandbox's tools read: one
# profile binds each URL's host, port and path subtree to the same credential.
run "one_key_for_two_endpoints" {
  variables {
    sandbox         = false
    api_endpoints   = ["https://integrate.api.example.com/v1", "https://ai.api.example.com/v1"]
    api_sandbox_env = "EXAMPLE_API_KEY"
  }
  assert {
    condition     = local.openshell.profiles["nemoclaw-api-booking"].endpoints == ["integrate.api.example.com:443/v1/**", "ai.api.example.com:443/v1/**"]
    error_message = "One API profile must bind every endpoint's host, port and path subtree."
  }
  assert {
    condition     = local.openshell.profiles["nemoclaw-api-booking"].credentials[*].env_vars == [["EXAMPLE_API_KEY"]]
    error_message = "The API profile must hold one key, in the variable the sandbox sees."
  }
  assert {
    condition     = local.openshell.registration_credentials["booking"] == { EXAMPLE_API_KEY = "env:NEMOCLAW_TEST_BOOKING_KEY" }
    error_message = "The API registration must hold the key under the chosen variable."
  }
}

# Removing credentials needs no destroy mode once no sandbox attaches them.
run "remove" {
  variables {
    sandbox = false
    enabled = false
  }
  assert {
    condition     = length(local.openshell.registrations) + length(local.openshell.profiles) + length(local.openshell.sandboxes) == 0 && local.openshell.workspaces == ["credentials"]
    error_message = "Removal must delete every object but the workspace."
  }
}

# Teardown mode lets the test's cleanup delete the workspace.
run "teardown" {
  variables {
    enabled    = false
    destroying = true
  }
}

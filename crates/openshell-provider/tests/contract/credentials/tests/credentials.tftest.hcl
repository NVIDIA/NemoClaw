# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
# Web search and API credentials: each resource owns a profile and the
# registration that holds the key, and recovers either one without replacing
# the sandbox that attaches it. Each observe_ run applies the previous run's
# configuration again and reads the fake gateway.

run "deploy" {}

run "observe_deployed" {
  assert {
    condition = [
      for registration in values(local.gateway_state.providers) : keys(registration.credentials)
      if startswith(registration.type, "nemoclaw-brave")
    ] == [["BRAVE_SEARCH_API_KEY"]]
    error_message = "The web search registration must take a Brave profile and hold the key."
  }
  assert {
    condition = [for profile in values(local.gateway_state.profiles) : profile.credentials[0].env_vars] == [
      ["NEMOCLAW_API_BOOKING_KEY"],
      ["BRAVE_SEARCH_API_KEY"],
    ]
    error_message = "Sandboxes must see each key under its named variable."
  }
  assert {
    condition = local.gateway_state.profiles["credentials/nemoclaw-api-booking"] == {
      id                = "nemoclaw-api-booking"
      inference_capable = false
      credentials       = [{ env_vars = ["NEMOCLAW_API_BOOKING_KEY"], auth_style = "bearer", header_name = "Authorization" }]
      endpoints         = ["booking.example.com:443/mcp/**"]
      binaries          = ["/usr/bin/curl"]
    }
    error_message = "The API profile must bind its bearer key to its endpoint and binaries."
  }
  assert {
    condition     = local.gateway_state.providers["credentials/booking"].type == "nemoclaw-api-booking" && local.gateway_state.providers["credentials/booking"].credentials == { NEMOCLAW_API_BOOKING_KEY = "booking-fixture-secret" }
    error_message = "The API registration must take its profile and hold the key."
  }
  assert {
    condition     = !strcontains(jsonencode(openshell_api.booking[0]), "booking-fixture-secret")
    error_message = "OpenTofu state must not hold the key."
  }
}

run "rotate_api_key" {
  variables { api_credential_env = "NEMOCLAW_TEST_BOOKING_NEXT" }
}

run "observe_rotated" {
  variables { api_credential_env = "NEMOCLAW_TEST_BOOKING_NEXT" }
  assert {
    condition     = local.gateway_state.providers["credentials/booking"].credentials == { NEMOCLAW_API_BOOKING_KEY = "next-booking-fixture-secret" } && local.gateway_state.created.providers == 2
    error_message = "Rotating the key's variable must update the registration in place."
  }
}

run "lose_profiles" {
  variables {
    api_credential_env = "NEMOCLAW_TEST_BOOKING_NEXT"
    fixture            = { remove = ["profiles"] }
  }
  plan_options { target = [data.fixture_state.gateway] }
}

run "recreate_profiles" {
  variables { api_credential_env = "NEMOCLAW_TEST_BOOKING_NEXT" }
}

run "lose_registrations" {
  variables {
    api_credential_env = "NEMOCLAW_TEST_BOOKING_NEXT"
    fixture            = { remove = ["providers"] }
  }
  plan_options { target = [data.fixture_state.gateway] }
}

run "recreate_registrations" {
  variables { api_credential_env = "NEMOCLAW_TEST_BOOKING_NEXT" }
}

run "observe_recreated" {
  variables { api_credential_env = "NEMOCLAW_TEST_BOOKING_NEXT" }
  assert {
    condition     = length(local.gateway_state.profiles) == 2 && local.gateway_state.created.providers == 4
    error_message = "Missing profiles must be recreated in place, and missing registrations created again: ${local.gateway_state.created.providers} registrations created."
  }
  assert {
    condition     = local.gateway_state.created.sandboxes == 1
    error_message = "Recovering credentials must keep the sandbox that attaches them."
  }
}

# Removing a sandbox is a teardown. Removing credentials needs no destroy
# mode once no sandbox attaches them.
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
}

run "observe_custom_header" {
  variables {
    sandbox     = false
    auth_style  = "header"
    header_name = "X-Booking-Key"
  }
  assert {
    condition     = local.gateway_state.profiles["credentials/nemoclaw-api-booking"].credentials[0].header_name == "X-Booking-Key"
    error_message = "The key must be sent in the named header."
  }
}

run "remove" {
  variables {
    sandbox = false
    enabled = false
  }
}

run "observe_removed" {
  variables {
    enabled    = false
    destroying = true
  }
  assert {
    condition     = length(local.gateway_state.providers) + length(local.gateway_state.profiles) + length(local.gateway_state.sandboxes) == 0 && local.gateway_state.workspaces == ["credentials"]
    error_message = "Removal must delete every object but the workspace."
  }
}

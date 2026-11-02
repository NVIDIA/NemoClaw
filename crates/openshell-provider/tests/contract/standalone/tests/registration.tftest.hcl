# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
# An inference registration without a sandbox: a new server endpoint or
# authentication mode replaces it, a rotated secret reference updates it, and
# removal deletes it without destroy mode. Each observe_ run applies the
# previous run's configuration again and reads the fake gateway.

variables {
  sandbox = false
}

run "deploy" {}

run "change_endpoint" {
  variables { inference_endpoint = "http://127.0.0.1:11435/v1" }
}

run "observe_changed_endpoint" {
  variables { inference_endpoint = "http://127.0.0.1:11435/v1" }
  assert {
    condition     = local.gateway_state.created.providers == 2 && values(local.gateway_state.providers)[0].config.OPENAI_BASE_URL == "http://127.0.0.1:11435/v1"
    error_message = "A new server endpoint must replace the registration."
  }
}

run "authenticate" {
  variables { credential_env = "NEMOCLAW_TEST_REGISTRATION_KEY" }
}

run "rotate_secret_reference" {
  variables { credential_env = "NEMOCLAW_TEST_ROTATED_KEY" }
}

run "observe_rotated" {
  variables { credential_env = "NEMOCLAW_TEST_ROTATED_KEY" }
  assert {
    condition     = local.gateway_state.created.providers == 3
    error_message = "Authenticating must replace the registration, and rotating its secret reference must update it in place: ${local.gateway_state.created.providers} created."
  }
  assert {
    condition     = values(local.gateway_state.providers)[0].credentials == { NEMOCLAW_INFERENCE_LOCAL_KEY = "rotated-fixture-secret" }
    error_message = "The registration must hold the rotated secret."
  }
}

run "stop_authenticating" {}

run "observe_anonymous" {
  assert {
    condition     = local.gateway_state.created.providers == 4
    error_message = "Dropping authentication must replace the registration."
  }
}

run "remove" {
  variables { enabled = false }
}

run "observe_removed" {
  variables {
    enabled    = false
    destroying = true
  }
  assert {
    condition     = length(local.gateway_state.providers) + length(local.gateway_state.profiles) == 0 && local.gateway_state.workspaces == ["standalone"]
    error_message = "Removal must delete the registration and its profile and keep the workspace."
  }
}

# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
# An inference registration without a sandbox: a new authentication mode or
# server endpoint replaces it, a rotated secret reference updates it, and
# removal deletes it without destroy mode.

variables {
  sandbox = false
}

run "deploy" {}

run "authenticate" {
  variables { credential_env = "NEMOCLAW_TEST_REGISTRATION_KEY" }
  assert {
    condition     = length(local.openshell.created_providers) == 2
    error_message = "Authenticating must replace the registration."
  }
}

run "rotate_secret_reference" {
  variables { credential_env = "NEMOCLAW_TEST_ROTATED_KEY" }
  assert {
    condition     = length(local.openshell.created_providers) == 2
    error_message = "Rotating the secret reference must update the registration in place."
  }
  assert {
    condition     = local.openshell.registration_credentials["local"] == { NEMOCLAW_INFERENCE_LOCAL_KEY = "env:NEMOCLAW_TEST_ROTATED_KEY" }
    error_message = "The registration must hold the rotated secret."
  }
}

run "stop_authenticating" {
  assert {
    condition     = length(local.openshell.created_providers) == 3
    error_message = "Dropping authentication must replace the registration."
  }
}

run "change_endpoint" {
  variables { inference_endpoint = "http://127.0.0.1:11435/v1" }
  assert {
    condition     = local.openshell.created_providers[3].config.OPENAI_BASE_URL == "http://127.0.0.1:11435/v1"
    error_message = "A new server endpoint must replace the registration."
  }
}

run "remove" {
  variables { enabled = false }
  assert {
    condition     = length(local.openshell.registrations) + length(local.openshell.profiles) == 0 && local.openshell.workspaces == ["standalone"]
    error_message = "Removal must delete the registration and its profile and keep the workspace."
  }
}

# Teardown mode lets the test's cleanup delete the workspace.
run "teardown" {
  variables {
    enabled    = false
    destroying = true
  }
}

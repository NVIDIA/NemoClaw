# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
# A sandbox that is already gone took its agent with it: removing the agent
# succeeds without a refresh, so the removal itself meets the absence.

run "deploy" {}

run "remove_agent_after_its_sandbox" {
  variables {
    agent   = false
    fixture = { remove = ["sandboxes"] }
  }
  plan_options { refresh = false }
}

run "teardown" {
  variables {
    enabled    = false
    destroying = true
  }
}

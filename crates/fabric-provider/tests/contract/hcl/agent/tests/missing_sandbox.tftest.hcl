# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
# A sandbox that is already gone took its agent with it: removing the agent
# succeeds without a refresh, so the removal itself meets the absence.

run "deploy" {}

run "lose_sandbox" {
  variables { fixture = { change = { forget_sandboxes = true } } }
  plan_options { target = [data.fixture_state.gateway] }
}

run "remove_agent" {
  variables { agent = false }
  plan_options { refresh = false }
}

run "teardown" {
  variables {
    enabled    = false
    destroying = true
  }
}

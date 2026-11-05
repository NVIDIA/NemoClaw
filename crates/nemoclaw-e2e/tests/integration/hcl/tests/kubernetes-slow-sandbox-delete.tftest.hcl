# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# The gateway takes 31 seconds to answer one sandbox deletion, longer than a
# request normally takes. The provider waits for the sandbox to stop without
# asking again, and the replacement sandbox is created afterward.

run "fixtures" {
  command = plan

  module {
    source = "./examples/kubernetes/external-gateway"
  }

  plan_options {
    target = [data.fixture_state.setup]
  }
}

run "deploy" {
  module {
    source = "./examples/kubernetes/external-gateway"
  }
}

run "replace_assistant" {
  module {
    source = "./examples/kubernetes/external-gateway"
  }

  variables {
    sandbox_delete_delay_ms = 31000
  }

  plan_options {
    replace = [openshell_sandbox.assistant]
  }
}

# Teardown's plan observes what the replacement left; cleanup is fast again.
run "teardown" {
  module {
    source = "./examples/kubernetes/external-gateway"
  }

  variables {
    permit_destroy = true
  }

  assert {
    condition     = module.observed.openshell.sandbox_deletes == 1
    error_message = "The provider deleted the slow sandbox more than once."
  }

  assert {
    condition = (
      length(module.observed.openshell.created_sandboxes) == 4
      && length(module.observed.openshell.sandboxes) == 3
    )
    error_message = "The assistant's replacement sandbox was not created after the slow deletion."
  }
}

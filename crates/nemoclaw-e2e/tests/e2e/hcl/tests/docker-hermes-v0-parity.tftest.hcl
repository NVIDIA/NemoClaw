# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# The v1 Hermes intent authored from a v0 hosted export (tests/hosted_parity.rs)
# on a managed Docker gateway: apply, a hosted reply, an unchanged plan, and
# destroy that keeps only the gateway's storage. Live / HCL runs it.

run "apply" {
  module {
    source = "./cli"
  }

  variables {
    operation = "apply"
  }

  assert {
    condition     = output.exit_code == 0 && output.result.outcome == "succeeded"
    error_message = "Apply failed: ${output.error}"
  }
}

# The agent runs after the apply process exited.
run "reply" {
  module {
    source = "./verifier"
  }

  variables {
    targets = {
      assistant = {
        agent            = "primary"
        request          = "Reply with exactly the word FOUR."
        response_pointer = "/output/response"
        answer           = "FOUR"
      }
    }
  }

  assert {
    condition     = length(output.failed) == 0
    error_message = "failed: ${join(", ", output.failed)}"
  }
}

run "unchanged_plan" {
  module {
    source = "./cli"
  }

  variables {
    operation = "plan"
  }

  assert {
    condition     = output.exit_code == 0 && output.changes == {}
    error_message = "A plan of the applied deployment has changes or failed: ${output.error}"
  }
}

run "destroy" {
  module {
    source = "./cli"
  }

  variables {
    operation = "destroy"
  }

  assert {
    condition = (
      output.exit_code == 0 && output.result.outcome == "destroyed"
      && toset(output.result.retained) == toset(["openshell_gateway_storage.runtime"])
    )
    error_message = "Destroy failed or retained other resources: ${output.error}"
  }
}

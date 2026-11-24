# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Hermes and Nemotron 3.5 Super VL on the Colossus GB300 runner.
# Adapted from the OpenClaw Station scenario at 0578e13851dc9ffc1e2ecc334c5ced64769456e2.
# Reuses the GTC Hermes Station example with the bound 3.5 model and candidate images.
# The caller independently verifies cleanup; integration tests cover unchanged
# reconciliation without reserving a GPU.

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
        agent            = "assistant"
        request          = "Reply with exactly the word READY."
        response_pointer = "/output/response"
        answer           = "READY"
      }
    }
  }

  assert {
    condition     = length(output.failed) == 0
    error_message = "failed: ${join(", ", output.failed)}"
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
    condition     = output.exit_code == 0 && output.result.outcome == "destroyed"
    error_message = "Destroy failed: ${output.error}"
  }
}

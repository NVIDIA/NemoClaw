# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# OpenClaw and Nemotron 3.5 Super VL on the manual Colossus GB300 runner.
# Reuses the vLLM lifecycle scenario at 02e69d1, adding unchanged apply and
# retained bearer credentials. The caller independently verifies cleanup.

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

run "unchanged_apply" {
  module {
    source = "./cli"
  }

  variables {
    operation       = "apply"
    baseline_agents = run.apply.result.agents
  }

  assert {
    condition = (
      output.exit_code == 0 && output.result.outcome == "succeeded"
      && output.changes == {} && output.result.agents == var.baseline_agents
    )
    error_message = "Unchanged apply changed resources or replaced the agent runtime."
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
      && toset(output.result.retained) == toset([
        "openshell_gateway_storage.runtime",
        "docker_volume.inference_storage_inference_super",
        "vllm_credential_storage.inference_super_auth",
      ])
    )
    error_message = "Destroy failed or retained other resources: ${output.error}"
  }
}

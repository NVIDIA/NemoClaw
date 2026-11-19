# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# OpenClaw on a NIM model the deployment serves on an NVIDIA GPU: apply, a
# correct arithmetic reply, an unchanged plan, and destroy that keeps the
# gateway's storage and the model's volume. Requires an entitled operator-owned
# NGC file at the configured Docker-host path. Run explicitly from the manual
# test directory until the GPU runner has the credential and image prerequisites.

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
        request          = "What is 2 plus 2? Reply with only the word FOUR."
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
    baseline  = run.apply.bindings
  }

  assert {
    condition     = output.exit_code == 0 && output.changes == {}
    error_message = "A plan of the applied deployment has changes or failed: ${output.error}"
  }
}

run "unchanged_apply" {
  module {
    source = "./cli"
  }
  variables {
    operation = "apply"
    baseline  = run.unchanged_plan.baseline
  }
  assert {
    condition     = output.exit_code == 0 && output.changes == {} && output.bindings == output.baseline
    error_message = "Unchanged apply must preserve the deployment and agent runtime bindings."
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
      && toset(output.result.retained) == toset(["openshell_gateway_storage.runtime", "docker_volume.inference_storage_inference_local-nim", "vllm_credential_storage.inference_local-nim_auth"])
    )
    error_message = "Destroy failed or retained other resources: ${output.error}"
  }
}

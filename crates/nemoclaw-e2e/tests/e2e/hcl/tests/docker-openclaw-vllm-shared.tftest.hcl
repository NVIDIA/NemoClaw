# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Two OpenClaw agents sharing one managed vLLM model with
# bearer authentication on an NVIDIA GPU: apply, a reply from each agent, an
# unchanged plan, and destroy that keeps the gateway's storage, the model's
# volume, and the service credential. Live / HCL runs it.

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

# The agents run after the apply process exited.
run "reply" {
  module {
    source = "./verifier"
  }

  variables {
    targets = {
      assistant = {
        agent            = "assistant"
        request          = "What is 2 plus 2? Answer in one short sentence."
        response_pointer = "/output/response"
      }
      researcher = {
        agent            = "researcher"
        request          = "What is 2 plus 2? Answer in one short sentence."
        response_pointer = "/output/response"
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
      && toset(output.result.retained) == toset([
        "openshell_gateway_storage.runtime",
        "docker_volume.inference_storage_inference_qwen",
        "vllm_credential_storage.inference_qwen_auth",
      ])
    )
    error_message = "Destroy failed or retained other resources: ${output.error}"
  }
}

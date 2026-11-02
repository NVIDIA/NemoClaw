# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# An OpenClaw agent on NVIDIA hosted inference and a Hermes agent on a managed
# Ollama model, on an NVIDIA GPU: apply, a reply from each agent, an unchanged
# plan, and destroy that keeps the gateway's storage and the model's volume.
# Live / HCL runs it.

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
        request          = "Reply with exactly the word FOUR."
        response_pointer = "/output/response"
        answer           = "FOUR"
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
        "docker_volume.ollama_service_storage_ollama-server",
      ])
    )
    error_message = "Destroy failed or retained other resources: ${output.error}"
  }
}

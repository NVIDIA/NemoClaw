# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Three agents with the OpenShift profile on a managed gateway in kind:
# apply, a reply from each agent's recorded runtime, an unchanged plan, and
# destroy that keeps only the gateway's storage. cargo ci live-kind runs it.
# The stub's reply shows each request reached it; no model runs.

run "cluster" {
  module {
    source = "./kind"
  }

  variables {
    kubeconfig = var.kubeconfig
    reply      = "nemoclaw-stub-reply"
  }
}

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

run "reply" {
  module {
    source = "./verifier"
  }

  variables {
    targets = {
      for agent in ["main", "researcher", "reviewer"] : agent => {
        agent            = agent
        request          = "Reply to this NemoClaw live test."
        response_pointer = "/output/response"
        answer           = "nemoclaw-stub-reply"
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
      && toset(output.result.retained) == toset(["openshell_kubernetes_storage.runtime"])
    )
    error_message = "Destroy failed or retained other resources: ${output.error}"
  }
}

# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# One row of examples/scenarios.md, bound to this machine by
# scenarios::page: a plan with changes, apply, a reply from every agent, an
# unchanged plan, and destroy. The runner passes the row as TF_VAR_scenario,
# a JSON object with `stub` (whether to serve the stub model), `port` (where
# it listens), and `targets` (the verifier's targets, one per agent), and the
# key the stub requires as TF_VAR_model_key. The runner destroys the deployment and
# removes what it labelled after the run, whatever its outcome.

run "model" {
  module {
    source = "./model"
  }

  variables {
    enabled = jsondecode(var.scenario).stub
    port    = jsondecode(var.scenario).port
    key     = var.model_key
    reply   = "nemoclaw-stub-reply"
  }
}

run "plan" {
  module {
    source = "./cli"
  }

  variables {
    operation = "plan"
  }

  assert {
    condition     = output.exit_code == 0 && length(output.changes) > 0
    error_message = "A plan of the new deployment failed or has no changes: ${output.error}"
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

# The agents run after the apply process exited.
run "reply" {
  module {
    source = "./verifier"
  }

  variables {
    targets = jsondecode(var.scenario).targets
  }

  assert {
    condition     = length(output.failed) == 0
    error_message = "These agents did not give the expected reply: ${join(", ", output.failed)}"
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
    condition     = output.exit_code == 0 && output.result.outcome == "destroyed"
    error_message = "Destroy failed: ${output.error}"
  }
}

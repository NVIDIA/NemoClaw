# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# One row of examples/scenarios.md whose deployment serves no model, bound to
# this machine by scenarios::page: the QA team's 005-DEPLOY and the live
# suites' unchanged plan. lifecycle-model.tftest.hcl is the same without the
# unchanged plan, for a deployment that serves a model.
#
# Each run block's name starts with what it checks, which scenarios::page
# reads to report it: `case_005_` belongs to 005-DEPLOY, reported by run ID
# such as DOCKER-OPENCLAW-005, and `check_unchanged_plan` to the unchanged
# plan. Any other run block is setup, and its failure fails every check.
#
# - 005-DEPLOY: plan without adding a container, volume, network, or image,
#   apply, get READY and then 391 from every agent, and destroy.
# - Unchanged plan: a plan of the applied deployment has no changes.
#
# Export, reapply, and recovery belong to the integration tests, which run
# against fixtures. scenarios::page passes a stub row as TF_VAR_scenario, a
# JSON object with `stub` (whether to serve the stub model) and `port` (where
# it listens), and the key the stub requires as TF_VAR_model_key. Whoever runs
# the scenario destroys the deployment and removes what it labelled
# afterward, whatever its outcome.

run "setup_model" {
  module {
    source = "./model"
  }

  variables {
    enabled = try(jsondecode(var.scenario).stub, false)
    port    = try(jsondecode(var.scenario).port, 1)
    key     = var.model_key
    reply   = "nemoclaw-stub-reply"
  }
}

run "case_005_inventory" {
  module {
    source = "./inventory"
  }
}

run "case_005_plan" {
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

run "case_005_plan_added_nothing" {
  module {
    source = "./inventory"
  }

  variables {
    baseline = run.case_005_inventory.objects
  }

  assert {
    condition     = output.objects == output.baseline
    error_message = "The plan added or removed Docker objects: before ${jsonencode(output.baseline)}, after ${jsonencode(output.objects)}"
  }
}

run "case_005_apply" {
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
run "case_005_reply" {
  module {
    source = "./verifier"
  }

  # READY, then 391, from every agent the deployment names, as 005-DEPLOY
  # asks; a stub row's stub gives one reply to both.
  variables {
    targets = merge([
      for name, sandbox in yamldecode(file(jsondecode(var.context).config)).spec.sandboxes : {
        "${name}-ready" = {
          agent            = sandbox.agent.name
          request          = "Reply with exactly READY."
          response_pointer = "/output/response"
          answer           = try(jsondecode(var.scenario).stub, false) ? "nemoclaw-stub-reply" : "READY"
        }
        "${name}-391" = {
          agent            = sandbox.agent.name
          request          = "What is 17 multiplied by 23? Reply with only the number."
          response_pointer = "/output/response"
          answer           = try(jsondecode(var.scenario).stub, false) ? "nemoclaw-stub-reply" : "391"
        }
      }
    ]...)
  }

  assert {
    condition     = length(output.failed) == 0
    error_message = "These agents did not reply READY, then 391: ${join(", ", output.failed)}"
  }
}

run "check_unchanged_plan" {
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

run "case_005_destroy" {
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

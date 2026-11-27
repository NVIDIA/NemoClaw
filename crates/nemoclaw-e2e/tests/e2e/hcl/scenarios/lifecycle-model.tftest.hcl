# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# One row of examples/scenarios.md whose deployment serves a model, bound to
# this machine by scenarios::page: the QA team's 005-DEPLOY, as
# lifecycle.tftest.hcl runs it, without the unchanged plan. As the live
# hardware cases do, it leaves unchanged reconciliation to the integration
# tests rather than hold a GPU for it.
#
# Each run block's name starts with `case_005_`, which scenarios::page reads to
# report it by run ID, such as SPARK-HERMES-005-E2E.
#
# - 005-DEPLOY: plan without adding a container, volume, network, or image,
#   apply, get READY and then 391 from every agent, and destroy.
#
# Whoever runs the scenario, scenarios::page or the Live / HCL workflow,
# destroys the deployment and removes what it labelled afterward, whatever its
# outcome.

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
  # asks.
  # var.context is a JSON string while the run block runs and the root
  # module's object when tofu test destroys the run's state afterward, so
  # read it either way; jsondecode alone fails that cleanup.
  variables {
    targets = merge([
      for name, sandbox in yamldecode(file(try(jsondecode(var.context), var.context).config)).spec.sandboxes : {
        "${name}-ready" = {
          agent            = sandbox.agent.name
          request          = "Reply with exactly READY."
          response_pointer = "/output/response"
          answer           = "READY"
        }
        "${name}-391" = {
          agent            = sandbox.agent.name
          request          = "What is 17 multiplied by 23? Reply with only the number."
          response_pointer = "/output/response"
          answer           = "391"
        }
      }
    ]...)
  }

  assert {
    condition     = length(output.failed) == 0
    error_message = "These agents did not reply READY, then 391: ${join(", ", output.failed)}"
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

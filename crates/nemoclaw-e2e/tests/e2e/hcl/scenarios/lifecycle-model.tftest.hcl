# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# One row of examples/scenarios.md whose deployment serves a model, bound to
# this machine by scenarios::page: the QA team's 005-DEPLOY, as
# lifecycle.tftest.hcl runs it, without the unchanged plan. As the live
# hardware cases do, it leaves unchanged reconciliation to the integration
# tests rather than hold a GPU for it.
#
# Each run block's name starts with `case_005_`, which scenarios::page reads to
# report it by run ID, such as SPARK-HERMES-005.
#
# - 005-DEPLOY: plan without adding a container, volume, network, or image,
#   apply, get READY and then 391 from every agent, and destroy.
#
# The runner passes the row as TF_VAR_scenario, a JSON object with `targets`
# (the verifier's targets, READY and 391 for each agent). It destroys the
# deployment and removes what it labelled after the run, whatever its outcome.

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

  variables {
    targets = jsondecode(var.scenario).targets
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

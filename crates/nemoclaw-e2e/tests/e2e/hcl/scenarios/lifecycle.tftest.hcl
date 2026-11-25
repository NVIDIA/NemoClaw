# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# One row of examples/scenarios.md, bound to this machine by
# scenarios::page, through two cases of the QA team's GTC DC test plan.
# Each run block's name starts with the case it belongs to, which
# scenarios::page reads to report run IDs such as SPARK-HERMES-005; a run
# that belongs to no case is setup, and its failure fails every case.
#
# - 005-DEPLOY: plan without adding a container, volume, network, or image,
#   apply, and get READY and then 391 from every agent.
# - 009-LIFECYCLE: export, plan and reapply the export without changes or
#   recreated sandboxes, get READY, preview destroy and get READY again,
#   destroy, destroy again without changes, and preview destroy without
#   changes.
#
# The runner passes the row as TF_VAR_scenario, a JSON object with `stub`
# (whether to serve the stub model), `port` (where it listens), `targets`
# (the verifier's targets for 005, READY and 391 for each agent), and
# `ready_targets` (the READY targets alone), and the key the stub requires as
# TF_VAR_model_key. The runner destroys the deployment and removes what it
# labelled after the run, whatever its outcome.

run "setup_model" {
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

run "case_009_export" {
  module {
    source = "./cli"
  }

  # OpenTofu keeps only a module's latest run's outputs, so the sandboxes
  # that apply bound travel on through each cli run's baseline.
  variables {
    operation = "export"
    baseline  = run.case_005_apply.bindings
  }

  # The export names the same gateway target, providers, and sandboxes, and
  # holds no credential value: the stub's key, when the row serves the stub,
  # appears only as an environment reference.
  assert {
    condition = (
      output.exit_code == 0
      && keys(yamldecode(output.exported.text).spec.gateway.target) == keys(yamldecode(file(jsondecode(var.context).config)).spec.gateway.target)
      && keys(yamldecode(output.exported.text).spec.sandboxes) == keys(yamldecode(file(jsondecode(var.context).config)).spec.sandboxes)
      && keys(try(yamldecode(output.exported.text).spec.inferenceProviders, {})) == keys(try(yamldecode(file(jsondecode(var.context).config)).spec.inferenceProviders, {}))
      && (var.model_key == "" || !strcontains(output.exported.text, var.model_key))
    )
    error_message = "The export failed, differs from the deployment, or holds a credential: ${output.error}"
  }
}

run "case_009_reapply_plan" {
  module {
    source = "./cli"
  }

  variables {
    operation = "plan"
    document  = run.case_009_export.exported.path
    baseline = {
      document = run.case_009_export.exported.path
      bindings = run.case_009_export.baseline
    }
  }

  assert {
    condition     = output.exit_code == 0 && output.changes == {}
    error_message = "A plan of the exported deployment has changes or failed: ${output.error}"
  }
}

run "case_009_reapply" {
  module {
    source = "./cli"
  }

  variables {
    operation = "apply"
    document  = run.case_009_reapply_plan.baseline.document
    baseline  = run.case_009_reapply_plan.baseline.bindings
  }

  assert {
    condition = (
      output.exit_code == 0 && output.result.outcome == "succeeded"
      && { for name, binding in output.bindings : name => binding.sandbox } == { for name, binding in output.baseline : name => binding.sandbox }
    )
    error_message = "Reapplying the export failed or recreated a sandbox: ${output.error}"
  }
}

run "case_009_reply_after_reapply" {
  module {
    source = "./verifier"
  }

  variables {
    targets = jsondecode(var.scenario).ready_targets
  }

  assert {
    condition     = length(output.failed) == 0
    error_message = "These agents did not reply READY after the reapply: ${join(", ", output.failed)}"
  }
}

run "case_009_destroy_preview" {
  module {
    source = "./cli"
  }

  variables {
    operation = "plan_destroy"
  }

  assert {
    condition     = output.exit_code == 0 && length(output.changes) > 0
    error_message = "The destroy preview failed or would remove nothing: ${output.error}"
  }
}

run "case_009_reply_after_preview" {
  module {
    source = "./verifier"
  }

  variables {
    targets = jsondecode(var.scenario).ready_targets
  }

  assert {
    condition     = length(output.failed) == 0
    error_message = "These agents did not reply READY after the destroy preview: ${join(", ", output.failed)}"
  }
}

run "case_009_destroy" {
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

run "case_009_destroy_again" {
  module {
    source = "./cli"
  }

  variables {
    operation = "destroy"
  }

  assert {
    condition     = output.exit_code == 0 && output.changes == {}
    error_message = "A second destroy failed or changed something: ${output.error}"
  }
}

run "case_009_destroy_preview_after" {
  module {
    source = "./cli"
  }

  variables {
    operation = "plan_destroy"
  }

  assert {
    condition     = output.exit_code == 0 && output.changes == {}
    error_message = "A destroy preview after destroy failed or has changes: ${output.error}"
  }
}

# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# One agent with the default kubernetes runtime and development
# authentication profiles on a managed gateway in kind: apply, a reply from
# the agent's recorded runtime, destroy that keeps only the gateway's
# storage, an install that an admission policy refuses, and a redeploy that
# reuses that storage and answers again.
# cargo ci live-kind runs it. The CLI runs with an empty PATH, so neither
# install needs a helm program. The stub's reply shows each request reached
# it; no model runs. The deployment is left in place after the second reply;
# the runner deletes the cluster.

run "cluster" {
  module {
    source = "./kind"
  }

  variables {
    kubeconfig = var.kubeconfig
    reply      = "nemoclaw-stub-reply"
    # The module reads TF_VAR_pull_credentials itself, as an object; the
    # test file's var.pull_credentials would be the raw string.
  }
}

run "apply" {
  module {
    source = "./cli"
  }

  variables {
    operation  = "apply"
    empty_path = true
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
      main = {
        agent            = "main"
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

run "destroy" {
  module {
    source = "./cli"
  }

  variables {
    operation  = "destroy"
    empty_path = true
  }

  assert {
    condition = (
      output.exit_code == 0 && output.result.outcome == "destroyed"
      && toset(output.result.retained) == toset(["openshell_kubernetes_storage.runtime"])
    )
    error_message = "Destroy failed or retained other resources: ${output.error}"
  }
}

# An admission policy refuses the gateway's StatefulSet, so the next install
# fails after Helm has stored its release (#14155). The atomic install removes
# the release: the apply fails with the refusal, no record of the release
# remains, and the state still binds the retained storage but not the release.
run "refuse_statefulsets" {
  module {
    source = "./admission"
  }

  variables {
    refuse = true
  }

  assert {
    condition     = output.refusing
    error_message = "The API server did not enforce the admission policy within a minute."
  }
}

run "refused_install" {
  module {
    source = "./cli"
  }

  variables {
    operation  = "apply"
    empty_path = true
  }

  assert {
    condition     = output.exit_code != 0 && strcontains(output.error, "nemoclaw-live-test-refuses-statefulsets")
    error_message = "The refused install did not fail with the refusal: ${output.error}"
  }
}

run "allow_statefulsets" {
  module {
    source = "./admission"
  }

  variables {
    refuse = false
  }

  assert {
    condition     = output.releases == 0
    error_message = "The failed install left ${jsonencode(output.releases)} records of the gateway's Helm release."
  }

  assert {
    condition = (
      contains(output.bound, "openshell_kubernetes_storage.runtime")
      && !contains(output.bound, "helm_release.gateway")
    )
    error_message = "The failed install bound the release or lost the storage: ${join(", ", output.bound)}"
  }
}

# The retained storage is refreshed, not created again: a namespace, key, or
# claim replaced while the gateway was removed would fail its refresh or plan
# a new storage resource.
run "redeploy" {
  module {
    source = "./cli"
  }

  variables {
    operation  = "apply"
    empty_path = true
  }

  assert {
    condition = (
      output.exit_code == 0 && output.result.outcome == "succeeded"
      && !contains(keys(output.changes), "openshell_kubernetes_storage.runtime")
    )
    error_message = "Redeploy failed or created the gateway's storage again: ${output.error}"
  }
}

run "reply_after_redeploy" {
  module {
    source = "./verifier"
  }

  variables {
    targets = {
      main = {
        agent            = "main"
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

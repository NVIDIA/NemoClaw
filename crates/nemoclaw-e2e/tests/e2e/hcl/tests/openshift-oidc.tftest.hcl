# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Two agents with the openshift profile on a managed gateway in OpenShift,
# whose restricted-v2 constraint assigns the gateway its UID and fsGroup:
# apply, a reply from each agent's recorded runtime, an unchanged plan, and
# destroy that keeps only the gateway's storage. No CI job has OpenShift, so
# it runs by hand, for example on OpenShift Local. The kind module prepares
# the cluster as it does on kind, except the namespace's UID range, which
# OpenShift writes. The stub's reply shows each request reached it; no model
# runs. The agent image comes from a private registry with the operator's
# pull Secret, and the CLI and the probe reach the gateway with a token from
# an existing OIDC issuer, so apply and the replies show that the gateway
# accepts that issuer's tokens.

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
      for agent in ["main", "researcher"] : agent => {
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

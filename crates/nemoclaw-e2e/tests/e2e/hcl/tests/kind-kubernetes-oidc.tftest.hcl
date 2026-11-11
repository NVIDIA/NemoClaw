# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Two agents on a managed gateway in kind, in a namespace annotated with
# OpenShift's UID range, so OpenShell runs each sandbox as its first UID:
# apply, which creates the NodePort Service that publishes the gateway; a
# reply from each agent's recorded runtime; an unchanged plan; and destroy
# that keeps only the gateway's storage. cargo ci live-kind runs it.
# The stub's reply shows each request reached it; no model runs. The agent
# image comes from the run's private registry with the operator's pull
# Secret, and the CLI and the probe reach the gateway with a token from an
# existing OIDC issuer, so apply and the replies show that the gateway
# accepts that issuer's tokens. Apply's reads of the gateway and the probe
# dial the node's address and verify the gateway's certificate there, as the
# SDK's providers do, through no port-forward.

run "cluster" {
  module {
    source = "./kind"
  }

  variables {
    kubeconfig = var.kubeconfig
    reply      = "nemoclaw-stub-reply"
    uid_range  = "1000680000/10000"
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

  assert {
    condition     = contains(keys(output.changes), "kubernetes_service_v1.gateway_exposure")
    error_message = "Apply did not create the exposure Service; it changed ${join(", ", keys(output.changes))}"
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

# The Service as the cluster returns it, with the fields Kubernetes fills in,
# must not plan a change.
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

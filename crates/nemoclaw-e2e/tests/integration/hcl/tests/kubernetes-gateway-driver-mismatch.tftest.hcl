# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# A Kubernetes document against a gateway that reports Docker. The gateway
# uses no engine, so nothing is mocked, and nothing is applied.

variables {
  compute_driver = "docker"
}

run "fixtures" {
  command = plan

  module {
    source = "./cases/kubernetes-gateway-driver-mismatch"
  }

  plan_options {
    target = [data.fixture_state.setup]
  }
}

# The workspace precondition rejects the plan before any gateway object is
# planned; dependent objects are never evaluated.
run "plan_rejects_incompatible_gateway" {
  command         = plan
  expect_failures = [openshell_workspace.deployment]

  module {
    source = "./cases/kubernetes-gateway-driver-mismatch"
  }
}

# The gateway names the missing driver, and nothing reached OpenShell, Fabric,
# or the upstream. A targeted plan evaluates no locals or module outputs, so the
# setup data source's own observations are decoded here.
run "nothing_changed" {
  command = plan

  module {
    source = "./cases/kubernetes-gateway-driver-mismatch"
  }

  plan_options {
    target = [data.openshell_gateway.current, data.fixture_state.setup]
  }

  assert {
    condition = (
      !data.openshell_gateway.current.compatible
      && strcontains(data.openshell_gateway.current.incompatibility, "kubernetes")
    )
    error_message = "The gateway did not report the missing Kubernetes driver."
  }

  assert {
    condition = (
      jsondecode(data.fixture_state.setup.observations).openshell.created_providers == []
      && jsondecode(data.fixture_state.setup.observations).openshell.created_sandboxes == []
      && jsondecode(data.fixture_state.setup.observations).openshell.execs == []
      && jsondecode(data.fixture_state.setup.observations).openshell.workspaces == []
      && jsondecode(data.fixture_state.setup.observations).http.requests == []
    )
    error_message = "An incompatible gateway received changes, or inference was called."
  }
}

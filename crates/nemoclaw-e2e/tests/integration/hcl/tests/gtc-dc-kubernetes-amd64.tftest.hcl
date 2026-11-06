# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# The GTC DC AMD64 Kubernetes example, examples/gtc-dc/kubernetes-amd64.yaml,
# compiled unchanged and planned against the fixtures with the real OpenShell
# and Fabric providers. The plan must use the existing Kubernetes gateway and
# create an OpenClaw and a Hermes sandbox whose agents use the hosted NVIDIA
# model, which the runner points at the fixture upstream. Nothing is applied;
# kubernetes-external-three-agents owns an external Kubernetes gateway's apply.

run "fixtures" {
  command = plan

  module {
    source = "./examples/gtc-dc/kubernetes-amd64"
  }

  plan_options {
    target = [data.fixture_state.setup]
  }
}

run "plan" {
  command = plan

  module {
    source = "./examples/gtc-dc/kubernetes-amd64"
  }

  assert {
    condition = (
      data.openshell_gateway.current.compatible
      && openshell_workspace.deployment.gateway == data.openshell_gateway.current.ref
    )
    error_message = "The plan does not create the deployment's workspace on the existing Kubernetes gateway."
  }

  assert {
    condition = (
      openshell_sandbox.openclaw.name == "openclaw"
      && data.fabric_harness.openclaw.adapter_id == "nvidia.fabric.openclaw"
      && openshell_sandbox.hermes.name == "hermes"
      && data.fabric_harness.hermes.adapter_id == "nvidia.fabric.hermes"
    )
    error_message = "The plan does not create the OpenClaw and Hermes sandboxes with their harnesses."
  }

  assert {
    condition = alltrue([
      for agent in [fabric_agent.openclaw, fabric_agent.hermes] :
      agent.models["primary"].model == "nvidia/nemotron-3.5-super-vl-120b-a12b"
      && agent.models["primary"].base_url == "${module.observed.http.endpoint}/v1"
    ])
    error_message = "An agent does not use the hosted NVIDIA model."
  }
}

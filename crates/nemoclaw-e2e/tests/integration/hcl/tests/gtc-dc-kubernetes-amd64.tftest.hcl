# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# The GTC DC AMD64 Kubernetes example, examples/gtc-dc/kubernetes-amd64.yaml,
# compiled and planned against the inference and image metadata fixtures.
# Kubernetes operations and Helm are mocked; the other providers are real.
# The plan must install a managed Kubernetes gateway and
# create an OpenClaw and a Hermes sandbox whose agents use the hosted NVIDIA
# model, which the runner points at the fixture upstream. Nothing is applied;
# kind-kubernetes-development owns a managed Kubernetes gateway's live apply.

mock_provider "helm" {}

override_resource {
  target = openshell_kubernetes_storage.runtime
  values = { running = "true" }
}

override_resource {
  target = openshell_kubernetes_auth.runtime
  values = { running = "true" }
}

override_resource {
  target = openshell_kubernetes_gateway.runtime
  values = { running = "true" }
}

variables {
  nemoclaw_kubeconfig = "/unused/mocked-kubeconfig"
}

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
      openshell_kubernetes_gateway.runtime.compute_driver == "kubernetes"
      && openshell_kubernetes_gateway.runtime.authentication_profile == "development"
      && helm_release.gateway.namespace == "nemoclaw-gtc-dc"
    )
    error_message = "The plan does not install a managed Kubernetes gateway with development authentication in the selected namespace."
  }

  assert {
    condition     = jsondecode(helm_release.gateway.values[0]).gatewayConfig["openshell.drivers.kubernetes"].allow_driver_config
    error_message = "The gateway chart does not allow the example's PVC driver configuration."
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

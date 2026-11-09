# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Plan the authored HCL without a cluster or agent images. OpenShell's native
# provider checks the resource inputs; Helm and Fabric are mocked. The live
# kind suite owns installation and agent replies.
mock_provider "helm" {}

mock_provider "fabric" {
  mock_data "fabric_harness" {
    defaults = {
      available   = true
      launch_json = "{\"binaries\":[\"/usr/bin/agent\"]}"
      ref = {
        type         = "fabric_harness"
        adapter_id   = "nvidia.fabric.fixture"
        image        = "fixture@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        catalog_json = "{}"
      }
    }
  }
}

run "plan" {
  command = plan

  module {
    source = "./examples/kubernetes/hosted-nvidia.tf"
  }

  variables {
    CLUSTER_KUBECONFIG = "/unused/mocked-kubeconfig"
  }

  assert {
    condition = (
      openshell_kubernetes_gateway.platform.compute_driver == "kubernetes"
      && openshell_kubernetes_gateway.platform.authentication_profile == "development"
      && helm_release.gateway.namespace == "nemoclaw-gtc-dc"
    )
    error_message = "The HCL does not install a managed Kubernetes development gateway."
  }

  assert {
    condition     = jsondecode(helm_release.gateway.values[0]).gatewayConfig["openshell.drivers.kubernetes"].allow_driver_config
    error_message = "The HCL gateway does not permit the sandbox PVC mounts."
  }

  assert {
    condition = alltrue([
      for name, sandbox in openshell_sandbox.agent :
      jsondecode(sandbox.driver_config).kubernetes.volumes[0].persistent_volume_claim.claim_name == "gtc-dc-${name}-data"
      && toset([for mount in jsondecode(sandbox.driver_config).kubernetes.containers.agent.volume_mounts : mount.mount_path]) == toset(["/sandbox/workspace", "/sandbox/artifacts"])
    ])
    error_message = "The HCL sandboxes do not mount their workspace and artifacts from separate per-agent PVCs."
  }

  assert {
    condition = alltrue([
      for agent in fabric_agent.agent :
      agent.models["primary"].model == "nvidia/nemotron-3.5-super-vl-120b-a12b"
      && agent.models["primary"].base_url == "https://integrate.api.nvidia.com/v1"
    ])
    error_message = "An HCL agent does not use the hosted NVIDIA model."
  }
}

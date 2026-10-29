# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# The same two-sandbox AMD64 Kubernetes setup as hosted-nvidia.yaml, in HCL.
# Choose one authoring path per deployment; keep its workspace and state separate.
# Pin both provider versions to the matching native bundle's manifest version.
# Adapted from examples/hcl/travel-team at 4b9f06c1c7f85724d0416a119241f6c335e23e9d.
terraform {
  required_version = "~> 1.12"
  required_providers {
    openshell = { source = "registry.opentofu.org/nvidia/openshell" }
    fabric    = { source = "registry.opentofu.org/nvidia/fabric" }
  }
}

variable "gateway_endpoint" {
  description = "Existing Kubernetes OpenShell gateway HTTPS endpoint."
  type        = string
  default     = "https://openshell.example.com"
}

variable "workspace" {
  description = "Fresh workspace name owned by this HCL deployment."
  type        = string
  default     = "gtc-dc-kubernetes-cloud"
}

variable "images" {
  description = "Linux AMD64 agent images, pushed to a registry the cluster can pull from and pinned by digest."
  type        = object({ openclaw = string, hermes = string })
  default = {
    openclaw = "registry.example.com/nemoclaw/openclaw@sha256:0000000000000000000000000000000000000000000000000000000000000000"
    hermes   = "registry.example.com/nemoclaw/hermes@sha256:0000000000000000000000000000000000000000000000000000000000000000"
  }
}

variable "destroy" {
  description = "Permit removing provider-owned objects during explicit teardown."
  type        = bool
  default     = false
}

provider "openshell" {
  destroy = var.destroy
}
provider "fabric" {
  destroy = var.destroy
}

data "openshell_gateway" "current" {
  endpoint                 = var.gateway_endpoint
  credential_env           = "GATEWAY_TOKEN"
  tls_ca_env               = "GATEWAY_CA"
  tls_certificate_env      = "GATEWAY_CERT"
  tls_key_env              = "GATEWAY_KEY"
  required_compute_drivers = ["kubernetes"]
}

locals {
  agents = {
    openclaw = { adapter_id = "nvidia.fabric.openclaw", metadata_env = "NEMOCLAW_OPENCLAW_IMAGE_METADATA" }
    hermes   = { adapter_id = "nvidia.fabric.hermes", metadata_env = "NEMOCLAW_HERMES_IMAGE_METADATA" }
  }
  inference = {
    endpoint = "https://integrate.api.nvidia.com/v1"
    model    = "nvidia/nemotron-3.5-super-vl-120b-a12b"
    api      = "openai-completions"
  }
  binaries = { for name, harness in data.fabric_harness.agent : name => jsondecode(harness.launch_json).binaries }
  configurations = {
    for name, agent in local.agents : name => {
      adapter_id  = agent.adapter_id
      model       = local.inference.model
      endpoint    = local.inference.endpoint
      api_key_env = openshell_inference.cloud[name].sandbox_env
    }
  }
}

data "fabric_harness" "agent" {
  for_each     = local.agents
  image        = var.images[each.key]
  metadata_env = each.value.metadata_env
  adapter_id   = each.value.adapter_id
  agent_name   = each.key
  lifecycle {
    postcondition {
      condition     = self.available
      error_message = "The matching agent image metadata must provide the selected Fabric harness."
    }
  }
}

resource "openshell_workspace" "deployment" {
  gateway = data.openshell_gateway.current.ref
  name    = var.workspace
  lifecycle {
    prevent_destroy = true
    precondition {
      condition     = data.openshell_gateway.current.compatible
      error_message = "The existing gateway must support the Kubernetes compute driver."
    }
  }
}

# As in the YAML compiler, each image/harness gets its own executable-bound
# registration for the shared cloud endpoint and credential reference.
resource "openshell_inference" "cloud" {
  for_each  = local.agents
  gateway   = data.openshell_gateway.current.ref
  workspace = openshell_workspace.deployment.ref
  name      = "hosted-nvidia-${each.key}"
  server = {
    type              = "inference_server"
    endpoint          = local.inference.endpoint
    credential_env    = "NVIDIA_INFERENCE_API_KEY"
    credential_source = ""
  }
  api      = local.inference.api
  binaries = local.binaries[each.key]
}

resource "terraform_data" "agent_config" {
  for_each = local.configurations
  input    = jsonencode(each.value)
}

resource "openshell_sandbox" "agent" {
  for_each    = local.agents
  gateway     = data.openshell_gateway.current.ref
  workspace   = openshell_workspace.deployment.ref
  owner       = openshell_workspace.deployment.owner
  name        = each.key
  image       = var.images[each.key]
  launch_json = data.fabric_harness.agent[each.key].launch_json
  providers   = [openshell_inference.cloud[each.key].ref]
  policy {
    explicit {
      version = 1
      process {
        run_as_user  = "10001"
        run_as_group = "10001"
      }
      filesystem_policy {
        include_workdir = true
        read_only = concat(
          ["/usr", "/opt/fabric", "/opt/nemoclaw", "/app"],
          each.key == "hermes" ? ["/opt/hermes", "/opt/nemo-relay/plugins/switchyard", "/etc/ssl/certs/ca-certificates.crt"] : [],
        )
        read_write = ["/sandbox"]
      }
      network_policies "hosted-inference" {
        name = "hosted-inference"
        endpoints {
          host = "integrate.api.nvidia.com"
          port = 443
        }
        binaries {
          path = each.key == "hermes" ? "/usr/local/bin/hermes" : "/usr/bin/openclaw"
        }
      }
    }
    managed {
      name = "nemoclaw-inference-${openshell_inference.cloud[each.key].name}"
      dynamic "binaries" {
        for_each = local.binaries[each.key]
        content {
          path = binaries.value
        }
      }
      endpoints {
        host     = "integrate.api.nvidia.com"
        port     = 443
        path     = "/v1/**"
        protocol = "rest"
        access   = "full"
      }
    }
  }
  lifecycle {
    replace_triggered_by = [terraform_data.agent_config[each.key]]
  }
}

resource "fabric_agent" "agent" {
  for_each = local.agents
  gateway  = data.openshell_gateway.current.ref
  sandbox  = openshell_sandbox.agent[each.key].ref
  harness  = data.fabric_harness.agent[each.key].ref
  name     = each.key
  dynamic "models" {
    for_each = ["default", "primary"]
    labels   = [models.value]
    content {
      provider    = "openai"
      model       = local.inference.model
      base_url    = local.inference.endpoint
      api_key_env = openshell_inference.cloud[each.key].sandbox_env
    }
  }
}

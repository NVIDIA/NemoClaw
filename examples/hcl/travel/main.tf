# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# A travel agent: Pi in an OpenShell sandbox, answering with a local Nemotron
# model served by Ollama, and allowed only HTTPS GET requests to
# travel.example.com.
#
# Everything here is plain HCL against the shipped providers. This example
# places Ollama with Docker; a Kubernetes, Podman, or other resource can take
# the same launch and requirements instead.

terraform {
  required_version = "= 1.12.6"
  # Pin the NVIDIA providers to your bundle's version, for example
  # version = "0.1.0", and install them from the bundle's providers directory.
  required_providers {
    docker    = { source = "registry.opentofu.org/kreuzwerker/docker", version = "4.6.0" }
    ollama    = { source = "registry.opentofu.org/nvidia/ollama" }
    openshell = { source = "registry.opentofu.org/nvidia/openshell" }
    fabric    = { source = "registry.opentofu.org/nvidia/fabric" }
  }
}

variable "docker_host" {
  description = "Docker engine that runs Ollama."
  type        = string
}
variable "gateway_endpoint" {
  description = "OpenShell gateway endpoint."
  type        = string
}
variable "ollama_image" {
  description = "Managed Ollama runtime image, pinned by digest."
  type        = string
}
variable "pi_image" {
  description = "Pi agent image, pinned by digest; it carries curl."
  type        = string
}
variable "pi_image_engine" {
  description = "Engine that holds the Pi image, read for its Fabric catalog."
  type        = string
}
variable "model" {
  description = "The Ollama model to serve, pinned by digest."
  type        = object({ name = string, digest = string })
}
variable "hardware_profile" {
  description = "The GPU host's hardware profile, which sizes Ollama's memory budget."
  type        = string
  default     = "dgx-spark"
}
variable "model_endpoint" {
  description = "Ollama's OpenAI-compatible URL from this machine, ending in /v1."
  type        = string
  default     = "http://127.0.0.1:11434/v1"
}
variable "sandbox_model_endpoint" {
  description = "Ollama's OpenAI-compatible URL from the gateway and sandboxes, ending in /v1. The default reaches a server on the gateway's host through OpenShell's alias; OpenShell checks the destination."
  type        = string
  default     = "http://host.openshell.internal:11434/v1"
}
variable "destroy" {
  description = "Permit deleting provider-owned objects; set for tofu destroy."
  type        = bool
  default     = false
}

provider "docker" {
  host = var.docker_host
}
provider "ollama" {
  destroy = var.destroy
}
provider "openshell" {
  destroy = var.destroy
}
provider "fabric" {
  destroy = var.destroy
}

# The model server: Ollama's runtime contract, placed with Docker.
data "ollama_runtime" "nemotron" {
  hardware {
    profile = var.hardware_profile
  }
  model {
    name   = var.model.name
    digest = var.model.digest
  }
  serving {
    port = 11434
  }
}

locals {
  launch       = data.ollama_runtime.nemotron.launch
  requirements = data.ollama_runtime.nemotron.requirements
}

resource "docker_volume" "models" {
  name = "travel-ollama-models"
}

resource "docker_container" "ollama" {
  name       = "travel-ollama"
  image      = var.ollama_image
  entrypoint = local.launch.entrypoint
  command    = local.launch.command
  env        = [for name, value in local.launch.environment : "${name}=${value}"]
  shm_size   = local.requirements.shared_memory_bytes / 1048576
  gpus       = local.requirements.gpu ? "all" : null
  restart    = "no"
  mounts {
    type   = "volume"
    source = docker_volume.models.name
    target = local.launch.data_path
  }
  ports {
    internal = local.launch.port
    external = local.launch.port
    ip       = "127.0.0.1"
  }
  dynamic "ulimit" {
    for_each = local.requirements.ulimits
    content {
      name = ulimit.key
      soft = ulimit.value
      hard = ulimit.value
    }
  }
}

# Ready once Ollama lists the model; its ref names the address sandboxes use.
data "ollama_readiness" "nemotron" {
  contract         = data.ollama_runtime.nemotron.spec
  endpoint         = var.model_endpoint
  sandbox_endpoint = coalesce(var.sandbox_model_endpoint, var.model_endpoint)
  read_trigger     = docker_container.ollama.id != ""
}

# The sandbox: Pi, with the model registered as its inference provider.
data "openshell_gateway" "current" {
  endpoint                 = var.gateway_endpoint
  required_compute_drivers = ["docker"]
}

data "fabric_harness" "pi" {
  image      = var.pi_image
  adapter_id = "nvidia.fabric.pi"
  agent_name = "travel"
  engine     = var.pi_image_engine
}

locals {
  gateway   = data.openshell_gateway.current.ref
  pi_launch = jsondecode(data.fabric_harness.pi.launch_json)
  model_url = regex("^https?://(?P<host>[^:/]+):(?P<port>[0-9]+)", data.ollama_readiness.nemotron.ref.endpoint)
}

# Tear the configuration down with tofu destroy -var destroy=true. To keep the
# workspace instead, add lifecycle { prevent_destroy = true } to it.
resource "openshell_workspace" "travel" {
  gateway = local.gateway
  name    = "travel"
}

# Registers the confirmed server with OpenShell, with the profile Pi uses to
# reach it.
resource "openshell_inference" "nemotron" {
  gateway   = local.gateway
  workspace = openshell_workspace.travel.ref
  name      = "nemotron"
  server    = data.ollama_readiness.nemotron.ref
  api       = "openai-completions"
  binaries  = local.pi_launch.binaries
}

# The agent's configuration. A changed agent needs a new sandbox, so changing
# it replaces the sandbox, deleting the sandbox's files.
locals {
  agent = {
    # The file's license comment is not an instruction.
    instructions = trimspace(replace(file("${path.module}/instructions.md"), "/(?s)<!--.*?-->/", ""))
    model        = data.ollama_readiness.nemotron.ref.model
  }
}

resource "terraform_data" "agent" {
  input = local.agent
}

resource "openshell_sandbox" "travel" {
  gateway     = local.gateway
  workspace   = openshell_workspace.travel.ref
  owner       = openshell_workspace.travel.owner
  name        = "travel"
  image       = var.pi_image
  launch_json = data.fabric_harness.pi.launch_json
  providers   = [openshell_inference.nemotron.ref]
  policy {
    managed "travel-nemotron" {
      name = "travel-nemotron"
      endpoints {
        host     = local.model_url.host
        port     = tonumber(local.model_url.port)
        path     = "/v1/**"
        protocol = "rest"
        access   = "full"
      }
    }
    managed "travel-example" {
      name = "travel-example"
      binaries {
        path = "/usr/bin/curl"
      }
      endpoints {
        host     = "travel.example.com"
        port     = 443
        protocol = "rest"
        rules {
          allow {
            method = "GET"
            path   = "/**"
          }
        }
      }
    }
  }
  lifecycle {
    replace_triggered_by = [terraform_data.agent]
  }
}

# The agent: Pi's configuration, applied inside the sandbox.
resource "fabric_agent" "travel" {
  gateway = local.gateway
  sandbox = openshell_sandbox.travel.ref
  harness = data.fabric_harness.pi.ref
  name    = "travel"
  instructions {
    system {
      content = local.agent.instructions
      mode    = "replace"
    }
  }
  models "default" {
    provider    = "openai"
    model       = local.agent.model
    api_key_env = "NEMOCLAW_ANONYMOUS_API_KEY"
  }
}

# The running agent's ID, for invoking it through fabric-agent-ctl.
output "runtime_id" {
  value = fabric_agent.travel.runtime_id
}

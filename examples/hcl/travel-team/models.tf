# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# The researchers' model: local and fast. Ollama's runtime contract, placed
# with Docker; a Kubernetes, Podman, or other resource can take the same launch
# and requirements instead.
data "ollama_runtime" "local" {
  hardware {
    profile = var.hardware_profile
  }
  memory {
    gpu_memory_gib = var.model_memory_gib
  }
  model {
    name   = var.local_model.name
    digest = var.local_model.digest
  }
  serving {
    port = 11434
    # The researchers share this model and work at the same time; NemoClaw's
    # Ollama runtime serves at most two sequences at once.
    max_sequences = min(length(local.researchers), 2)
  }
}

locals {
  ollama_launch       = data.ollama_runtime.local.launch
  ollama_requirements = data.ollama_runtime.local.requirements
}

resource "docker_volume" "models" {
  name = "travel-team-ollama-models"
}

resource "docker_container" "ollama" {
  name       = "travel-team-ollama"
  image      = var.ollama_image
  entrypoint = local.ollama_launch.entrypoint
  command    = local.ollama_launch.command
  env        = [for name, value in local.ollama_launch.environment : "${name}=${value}"]
  shm_size   = local.ollama_requirements.shared_memory_bytes / 1048576
  gpus       = local.ollama_requirements.gpu ? "all" : null
  restart    = "no"
  mounts {
    type   = "volume"
    source = docker_volume.models.name
    target = local.ollama_launch.data_path
  }
  ports {
    internal = local.ollama_launch.port
    external = local.ollama_launch.port
    ip       = var.model_bind_address
  }
  dynamic "ulimit" {
    for_each = local.ollama_requirements.ulimits
    content {
      name = ulimit.key
      soft = ulimit.value
      hard = ulimit.value
    }
  }
}

# Ready once Ollama lists the model; its ref names the address sandboxes use.
data "ollama_readiness" "local" {
  contract         = data.ollama_runtime.local.spec
  endpoint         = var.model_endpoint
  sandbox_endpoint = coalesce(var.sandbox_model_endpoint, var.model_endpoint)
  read_trigger     = docker_container.ollama.id != ""
}

# The scheduler's and buyer's model: hosted, for the parts that need the most
# reasoning. NemoClaw doesn't run it, so its server is a literal object rather
# than a readiness read's ref. OpenShell reads the key from credential_env
# during apply; the key never enters OpenTofu state.
locals {
  # The local model's server, from the address sandboxes use. Its readiness
  # read reports the same values only during apply when the server changes;
  # a registration taking that ref would be replaced, which OpenShell refuses
  # while sandboxes attach it. The registration waits for the read instead.
  local_server = {
    type              = "inference_server"
    endpoint          = coalesce(var.sandbox_model_endpoint, var.model_endpoint)
    credential_env    = ""
    credential_source = ""
  }
  frontier_server = {
    type              = "inference_server"
    endpoint          = var.frontier.endpoint
    credential_env    = var.frontier.credential_env
    credential_source = ""
  }
}
